/*
 * Copyright (c) 2016 MariaDB Corporation Ab
 *
 * Use of this software is governed by the Business Source License included
 * in the LICENSE.TXT file and at www.mariadb.com/bsl11.
 *
 * Change Date: 2023-11-12
 *
 * On the date above, in accordance with the Business Source License, use
 * of this software will be governed by version 2 or later of the General
 * Public License.
 */

#include "pam_client_session.hh"

#include <set>
#include <maxbase/pam_utils.hh>
#include <maxscale/event.hh>
#include "pam_instance.hh"
#include <maxscale/protocol/mariadb/protocol_classes.hh>

using maxscale::Buffer;
using std::string;
using AuthRes = mariadb::ClientAuthenticator::AuthRes;
using mariadb::UserEntry;

namespace
{
/**
 * @brief Read the client's password, store it to MySQL-session
 *
 * @param buffer Buffer containing the password
 * @return True on success, false if memory allocation failed
 */
bool store_client_password(MYSQL_session* session, GWBUF* buffer)
{
    bool rval = false;
    uint8_t header[MYSQL_HEADER_LEN];

    if (gwbuf_copy_data(buffer, 0, MYSQL_HEADER_LEN, header) == MYSQL_HEADER_LEN)
    {
        size_t plen = gw_mysql_get_byte3(header);
        session->auth_token.resize(plen);
        gwbuf_copy_data(buffer, MYSQL_HEADER_LEN, plen, session->auth_token.data());
        rval = true;
    }
    return rval;
}

}

PamClientAuthenticator::PamClientAuthenticator(PamAuthenticatorModule* instance)
    : ClientAuthenticatorT(instance)
{
}

mariadb::SClientAuth PamClientAuthenticator::create(PamAuthenticatorModule* inst)
{
    mariadb::SClientAuth new_auth(new(std::nothrow) PamClientAuthenticator(inst));
    return new_auth;
}

/**
 * @brief Create an AuthSwitchRequest packet
 *
 * The server (MaxScale) sends the plugin name "dialog" to the client with the
 * first password prompt. We want to avoid calling the PAM conversation function
 * more than once because it blocks, so we "emulate" its behaviour here.
 * This obviously only works with the basic password authentication scheme.
 *
 * @return Allocated packet
 * @see
 * https://dev.mysql.com/doc/internals/en/connection-phase-packets.html#packet-Protocol::AuthSwitchRequest
 */
Buffer PamClientAuthenticator::create_auth_change_packet() const
{
    /**
     * The AuthSwitchRequest packet:
     * 4 bytes     - Header
     * 0xfe        - Command byte
     * string[NUL] - Auth plugin name
     * byte        - Message type
     * string[EOF] - Message
     */
    size_t plen = 1 + DIALOG_SIZE + 1 + PASSWORD.length();
    size_t buflen = MYSQL_HEADER_LEN + plen;
    uint8_t bufdata[buflen];
    uint8_t* pData = bufdata;
    gw_mysql_set_byte3(pData, plen);
    pData += 3;
    *pData++ = m_sequence;
    *pData++ = MYSQL_REPLY_AUTHSWITCHREQUEST;
    memcpy(pData, DIALOG.c_str(), DIALOG_SIZE); // Plugin name
    pData += DIALOG_SIZE;
    *pData++ = DIALOG_ECHO_DISABLED;
    memcpy(pData, PASSWORD.c_str(), PASSWORD.length());     // First message

    Buffer buffer(bufdata, buflen);
    return buffer;
}

AuthRes PamClientAuthenticator::authenticate(DCB* generic_dcb, const UserEntry* entry)
{
    using mxb::PamResult;
    mxb_assert(generic_dcb->role() == DCB::Role::CLIENT);
    auto dcb = static_cast<ClientDCB*>(generic_dcb);

    auto rval = AuthRes::SSL_READY;
    auto ses = static_cast<MYSQL_session*>(dcb->session()->protocol_data());
    if (!ses->user.empty())
    {
        rval = AuthRes::FAIL;
        if (m_state == State::INIT)
        {
            /** We need to send the authentication switch packet to change the
             * authentication to something other than the 'mysql_native_password'
             * method */
            Buffer authbuf = create_auth_change_packet();
            if (authbuf.length() && dcb->protocol_write(authbuf.release()))
            {
                m_state = State::ASKED_FOR_PW;
                rval = AuthRes::INCOMPLETE;
            }
        }
        else if (m_state == State::PW_RECEIVED)
        {
            /** We sent the authentication change packet + plugin name and the client
             * responded with the password. Try to continue authentication without more
             * messages to client. */
            string password((char*)ses->auth_token.data(), ses->auth_token.size());

            // The server PAM plugin uses "mysql" as the default service when authenticating
            // a user with no service.
            string pam_service = entry->auth_string.empty() ? "mysql" : entry->auth_string;
            PamResult res = mxb::pam_authenticate(ses->user, password, dcb->remote(), pam_service, PASSWORD);
            if (res.type == PamResult::Result::SUCCESS)
            {
                rval = AuthRes::SUCCESS;
            }
            else
            {
                if (res.type == PamResult::Result::WRONG_USER_PW)
                {
                    rval = AuthRes::FAIL_WRONG_PW;
                }
                MXS_LOG_EVENT(maxscale::event::AUTHENTICATION_FAILURE, "%s",
                              res.error.c_str());
            }

            m_state = State::DONE;
        }
    }
    return rval;
}

bool PamClientAuthenticator::extract(GWBUF* buffer, MYSQL_session* session)
{
    gwbuf_copy_data(buffer, MYSQL_SEQ_OFFSET, 1, &m_sequence);
    m_sequence++;
    bool rval = false;

    switch (m_state)
    {
        case State::INIT:
        // The buffer doesn't have any PAM-specific data yet, as it's the normal HandShakeResponse.
        rval = true;
        break;

        case State::ASKED_FOR_PW:
        // Client should have responses with password.
        if (store_client_password(session, buffer))
        {
            m_state = State::PW_RECEIVED;
            rval = true;
        }
        break;

    default:
        MXS_ERROR("Unexpected authentication state: %d", static_cast<int>(m_state));
        mxb_assert(!true);
        break;
    }
    return rval;
}

