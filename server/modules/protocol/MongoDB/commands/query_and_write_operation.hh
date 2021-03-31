/*
 * Copyright (c) 2020 MariaDB Corporation Ab
 *
 * Use of this software is governed by the Business Source License included
 * in the LICENSE.TXT file and at www.mariadb.com/bsl11.
 *
 * Change Date: 2024-08-24
 *
 * On the date above, in accordance with the Business Source License, use
 * of this software will be governed by version 2 or later of the General
 * Public License.
 */

//
// https://docs.mongodb.com/manual/reference/command/nav-crud/
//

#include "defs.hh"
#include <maxbase/worker.hh>

namespace mxsmongo
{

namespace command
{

class OrderedCommand : public Command
{
public:
    template<class ConcretePacket>
    OrderedCommand(const std::string& name,
                   Database* pDatabase,
                   GWBUF* pRequest,
                   const ConcretePacket& req,
                   const bsoncxx::document::view& doc,
                   const DocumentArguments& arguments,
                   const std::string& array_key)
        : Command(name, pDatabase, pRequest, req, doc, arguments)
        , m_key(array_key)
    {
    }

public:
    GWBUF* execute() override final
    {
        auto ordered = m_doc[key::ORDERED];

        if (ordered)
        {
            if (ordered.type() != bsoncxx::type::k_bool)
            {
                stringstream ss;
                ss << "BSON field '" << m_name << ".ordered' is the wrong type '"
                   << bsoncxx::to_string(ordered.type())
                   << "', expected type 'bool'";

                throw SoftError(ss.str(), error::TYPE_MISMATCH);
            }

            m_ordered = ordered.get_bool();
        }

        auto it = m_arguments.find(m_key);

        if (it != m_arguments.end())
        {
            const auto& documents = it->second;
            check_write_batch_size(documents.size());

            for (auto doc : documents)
            {
                m_statements.push_back(convert_document(doc));
            }
        }
        else
        {
            auto element = m_doc[m_key];

            if (!element)
            {
                stringstream ss;
                ss << "BSON field '" << m_name << "." << m_key << "' is missing but a required field";

                throw SoftError(ss.str(), error::LOCATION40414);
            }

            if (element.type() != bsoncxx::type::k_array)
            {
                stringstream ss;
                ss << "invalid parameter: expected an object (" << m_key << ")";

                throw SoftError(ss.str(), error::LOCATION10065);
            }

            auto documents = static_cast<bsoncxx::array::view>(element.get_array());
            auto nDocuments = std::distance(documents.begin(), documents.end());
            check_write_batch_size(nDocuments);

            int i = 0;
            for (auto element : documents)
            {
                if (element.type() != bsoncxx::type::k_document)
                {
                    stringstream ss;
                    ss << "BSON field '" << m_name << "." << m_key << "."
                       << i << "' is the wrong type '"
                       << bsoncxx::to_string(element.type())
                       << "', expected type 'object'";

                    throw SoftError(ss.str(), error::TYPE_MISMATCH);
                }

                m_statements.push_back(convert_document(element.get_document()));
            }
        }

        m_it = m_statements.begin();

        execute_one_statement();

        return nullptr;
    }

    State translate(GWBUF& mariadb_response, GWBUF** ppResponse) override final
    {
        // TODO: Update will be needed when DEPRECATE_EOF it turned on.
        GWBUF* pResponse = nullptr;

        ComResponse response(GWBUF_DATA(&mariadb_response));

        bool abort = false;

        switch (response.type())
        {
        case ComResponse::OK_PACKET:
            interpret(ComOK(response));
            break;

        case ComResponse::ERR_PACKET:
            if (m_ordered)
            {
                abort = true;
            }

            add_error(m_write_errors, ComERR(response), m_it - m_statements.begin());
            break;

        case ComResponse::LOCAL_INFILE_PACKET:
        default:
            mxb_assert(!true);
        }

        ++m_it;

        State rv = BUSY;

        if (m_it == m_statements.end() || abort)
        {
            DocumentBuilder doc;

            auto write_errors = m_write_errors.extract();
            bool ok = write_errors.view().empty();

            doc.append(kvp("ok", ok));
            doc.append(kvp("n", m_n));

            amend_response(doc);

            if (!ok)
            {
                doc.append(kvp("writeErrors", write_errors));
            }

            pResponse = create_response(doc.extract());
            rv = READY;
        }
        else
        {
            execute_one_statement();
        }

        *ppResponse = pResponse;
        return rv;
    }

protected:
    virtual string convert_document(const bsoncxx::document::view& doc) = 0;

    virtual void interpret(const ComOK& response) = 0;

    virtual void amend_response(DocumentBuilder& response)
    {
    }

    void execute_one_statement()
    {
        mxb_assert(m_it != m_statements.end());

        send_downstream(*m_it);
    }

    string                         m_key;
    bool                           m_ordered { true };
    vector<string>                 m_statements;
    vector<string>::iterator       m_it;
    int32_t                        m_n { 0 };
    bsoncxx::builder::basic::array m_write_errors;
};

class TableCreatingCommand : public Command
{
public:
    using Command::Command;

    using Worker = mxb::Worker;

    ~TableCreatingCommand()
    {
        if (m_dcid)
        {
            Worker::get_current()->cancel_delayed_call(m_dcid);
        }
    }

    GWBUF* execute() override final
    {
        if (m_statement.empty())
        {
            m_statement = create_statement();
        }

        send_downstream(m_statement);

        return nullptr;
    }

    State translate(GWBUF& mariadb_response, GWBUF** ppResponse) override final
    {
        State state = BUSY;
        GWBUF* pResponse = nullptr;

        ComResponse response(GWBUF_DATA(&mariadb_response));

        if (m_mode == NORMAL)
        {
            if (!response.is_err() || ComERR(response).code() != ER_NO_SUCH_TABLE)
            {
                state = translate(response, &pResponse);
            }
            else
            {
                if (m_database.config().auto_create_tables)
                {
                    // The table did not exist, so it must be created.
                    mxb_assert(m_dcid == 0);

                    m_dcid = Worker::get_current()->delayed_call(0, [this](Worker::Call::action_t action) {
                            m_dcid = 0;

                            if (action == Worker::Call::EXECUTE)
                            {
                                m_mode = TABLE_CREATING;

                                stringstream ss;
                                ss << "CREATE TABLE "
                                   << table_name()
                                   << " (id TEXT NOT NULL UNIQUE, doc JSON)";

                                send_downstream(ss.str());
                            }

                            return false;
                        });
                }
                else
                {
                    stringstream ss;
                    ss << "Table " << table_name() << " does not exist, and 'auto_create_tables' "
                       << "is false.";

                    pResponse = create_hard_error(ss.str(), error::COMMAND_FAILED);
                    state = READY;
                }
            }
        }
        else
        {
            mxb_assert(m_mode == TABLE_CREATING);
            mxb_assert(!m_statement.empty());

            switch (response.type())
            {
            case ComResponse::OK_PACKET:
                MXS_NOTICE("TABLE created, now executing statment.");
                m_mode = NORMAL;
                send_downstream(m_statement);
                break;

            case ComResponse::ERR_PACKET:
                {
                    ComERR err(response);

                    auto code = err.code();

                    if (code == ER_TABLE_EXISTS_ERROR)
                    {
                        MXS_NOTICE("TABLE created by someone else, now executing statment.");
                        m_mode = NORMAL;
                        send_downstream(m_statement);
                    }
                    else
                    {
                        MXS_ERROR("Could not create table: (%d), %s", err.code(), err.message().c_str());
                        pResponse = create_hard_error(err.message(), error::from_mariadb_code(code));
                        state = READY;
                    }
                }
                break;

            default:
                mxb_assert(!true);
                MXS_ERROR("Expected OK or ERR packet, received something else.");
                pResponse = create_hard_error("Unexpected response received from backend.",
                                              error::COMMAND_FAILED);
                state = READY;
            }
        }

        mxb_assert((state == BUSY && pResponse == nullptr) || (state == READY && pResponse != nullptr));
        *ppResponse = pResponse;
        return state;
    }

protected:
    virtual string create_statement() const = 0;
    virtual string table_name() const = 0;
    virtual State translate(ComResponse& response, GWBUF** ppResponse) = 0;

private:
    enum Mode
    {
        NORMAL,
        TABLE_CREATING,
    };

    Mode     m_mode { NORMAL };
    string   m_statement;
    uint32_t m_dcid { 0 };
};


// https://docs.mongodb.com/manual/reference/command/delete/
class Delete : public OrderedCommand
{
public:
    template<class ConcretePacket>
    Delete(const std::string& name,
           Database* pDatabase,
           GWBUF* pRequest,
           const ConcretePacket& req,
           const bsoncxx::document::view& doc,
           const DocumentArguments& arguments)
        : OrderedCommand(name, pDatabase, pRequest, req, doc, arguments, key::DELETES)
    {
    }

private:
    string convert_document(const bsoncxx::document::view& doc) override
    {
        stringstream sql;

        sql << "DELETE FROM " << get_table(key::DELETE) << " ";

        auto q = doc["q"];

        if (!q)
        {
            throw SoftError("BSON field 'delete.deletes.q' is missing but a required field",
                            error::LOCATION40414);
        }

        if (q.type() != bsoncxx::type::k_document)
        {
            stringstream ss;
            ss << "BSON field 'delete.deletes.q' is the wrong type '"
               << bsoncxx::to_string(q.type()) << "' expected type 'object'";
            throw SoftError(ss.str(), error::TYPE_MISMATCH);
        }

        sql << query_to_where_clause(q.get_document());

        auto limit = doc["limit"];

        if (!limit)
        {
            throw SoftError("BSON field 'delete.deletes.limit' is missing but a required field",
                            error::LOCATION40414);
        }

        if (limit)
        {
            double nLimit = 0;

            if (get_number_as_double(limit, &nLimit))
            {
                if (nLimit != 0 && nLimit != 1)
                {
                    stringstream ss;
                    ss << "The limit field in delete objects must be 0 or 1. Got " << nLimit;

                    throw SoftError(ss.str(), error::FAILED_TO_PARSE);
                }
            }

            // Yes, if the type of the value is something else, there is no limit.

            if (nLimit == 1)
            {
                sql << " LIMIT 1";
            }
        }

        return sql.str();
    }

    void interpret(const ComOK& response)
    {
        m_n += response.affected_rows();
    }
};


// https://docs.mongodb.com/manual/reference/command/find/
class Find : public Command
{
public:
    using Command::Command;

    GWBUF* execute() override
    {
        stringstream sql;
        sql << "SELECT ";

        auto projection = m_doc[key::PROJECTION];

        if (projection)
        {
            m_extractions = projection_to_extractions(projection.get_document());

            if (!m_extractions.empty())
            {
                string s;
                for (auto extraction : m_extractions)
                {
                    if (!s.empty())
                    {
                        s += ", ";
                    }

                    s += "JSON_EXTRACT(doc, '$." + extraction + "')";
                }

                sql << s;
            }
            else
            {
                sql << "doc";
            }
        }
        else
        {
            sql << "doc";
        }

        sql << " FROM " << get_table(key::FIND) << " ";

        auto filter = m_doc[key::FILTER];

        if (filter)
        {
            const auto& doc = filter.get_document();

            sql << query_to_where_clause(doc);
        }

        auto sort = m_doc[key::SORT];

        if (sort)
        {
            const auto& doc = sort.get_document();
            string order_by = sort_to_order_by(doc);

            MXS_NOTICE("Sort '%s' converted to 'ORDER BY %s'.",
                       bsoncxx::to_json(doc).c_str(),
                       order_by.c_str());

            if (!order_by.empty())
            {
                sql << "ORDER BY " << order_by << " ";
            }
        }

        sql << convert_skip_and_limit();

        send_downstream(sql.str());

        return nullptr;
    }

    State translate(GWBUF& mariadb_response, GWBUF** ppResponse) override
    {
        // TODO: Update will be needed when DEPRECATE_EOF it turned on.
        GWBUF* pResponse = nullptr;

        ComResponse response(GWBUF_DATA(&mariadb_response));

        switch (response.type())
        {
        case ComResponse::OK_PACKET:
            break;

        case ComResponse::ERR_PACKET:
            {
                ComERR err(response);

                auto code = err.code();

                if (code == ER_NO_SUCH_TABLE)
                {
                    pResponse = translate_resultset(m_extractions, nullptr);
                }
                else
                {
                    MXS_WARNING("Mongo request to backend failed: (%d), %s", code, err.message().c_str());

                    pResponse = create_hard_error(err.message(), error::from_mariadb_code(code));
                }
            }
            break;

        case ComResponse::LOCAL_INFILE_PACKET:
            // This should not happen as the respon
            mxb_assert(!true);
            break;

        default:
            // Must be a result set.
            pResponse = translate_resultset(m_extractions, &mariadb_response);
        }

        *ppResponse = pResponse;
        return READY;
    }

private:
    vector<string> m_extractions;
};


// https://docs.mongodb.com/manual/reference/command/findAndModify/

// https://docs.mongodb.com/manual/reference/command/getLastError/

// https://docs.mongodb.com/manual/reference/command/getMore/

// https://docs.mongodb.com/manual/reference/command/insert/
class Insert : public TableCreatingCommand
{
public:
    using TableCreatingCommand::TableCreatingCommand;

    string create_statement() const override final
    {
        stringstream sql;
        sql << "INSERT INTO " << table_name() << " (id, doc) VALUES ";

        auto it = m_arguments.find(key::DOCUMENTS);

        if (it != m_arguments.end())
        {
            const auto& docs = it->second;
            check_write_batch_size(docs.size());

            bool first = true;
            for (auto doc : docs)
            {
                ++m_nDocuments;

                if (first)
                {
                    first = false;
                }
                else
                {
                    sql << ", ";
                }

                sql << convert_document(doc);
            }
        }
        else
        {
            auto element = m_doc[key::DOCUMENTS];

            if (!element)
            {
                throw SoftError("BSON field 'insert.documents' is missing but a required field",
                                error::LOCATION40414);
            }

            if (element.type() != bsoncxx::type::k_array)
            {
                throw SoftError("invalid parameter: expected an object (documents)",
                                error::LOCATION10065);
            }

            auto documents = static_cast<bsoncxx::array::view>(element.get_array());
            check_write_batch_size(std::distance(documents.begin(), documents.end()));

            bool first = true;
            for (auto element : documents)
            {
                ++m_nDocuments;

                if (first)
                {
                    first = false;
                }
                else
                {
                    sql << ", ";
                }

                sql << convert_document(element.get_document());
            }
        }

        return sql.str();
    }

    string table_name() const override final
    {
        return get_table(key::INSERT);
    }

    State translate(ComResponse& response, GWBUF** ppResponse) override final
    {
        DocumentBuilder doc;

        int32_t ok = response.is_ok() ? 1 : 0;
        int32_t n = response.is_ok() ? m_nDocuments : 0;

        doc.append(kvp("ok", ok));
        doc.append(kvp("n", n));

        switch (response.type())
        {
        case ComResponse::OK_PACKET:
            break;

        case ComResponse::ERR_PACKET:
            add_error(doc, ComERR(response));
            break;

        case ComResponse::LOCAL_INFILE_PACKET:
        default:
            mxb_assert(!true);
        }

        GWBUF* pResponse = create_response(doc.extract());

        *ppResponse = pResponse;
        return READY;
    }

private:
    static string convert_document(const bsoncxx::document::view& doc)
    {
        stringstream sql;
        sql << "(";

        auto id = get_id(doc["_id"]);

        sql << id;
        sql << ", '";
        sql << bsoncxx::to_json(doc);
        sql << "'";

        sql << ")";

        return sql.str();
    }

    static string get_id(const bsoncxx::document::element& element)
    {
        stringstream ss;

        if (element)
        {
            switch (element.type())
            {
            case bsoncxx::type::k_utf8:
                {
                    const auto& utf8 = element.get_utf8();
                    ss << "'" << string(utf8.value.data(), utf8.value.size()) << "'";
                }
                break;

            case bsoncxx::type::k_oid:
                ss << "'" << element.get_oid().value.to_string() << "'";
                break;

            case bsoncxx::type::k_int32:
                ss << element.get_int32();
                break;

            case bsoncxx::type::k_int64:
                ss << element.get_int64();
                break;

                // By design not using 'default' so that if a new type is introduced,
                // an explicit decision regarding what to do with it, will be needed.
            case bsoncxx::type::k_array:
            case bsoncxx::type::k_binary:
            case bsoncxx::type::k_bool:
            case bsoncxx::type::k_code:
            case bsoncxx::type::k_decimal128:
            case bsoncxx::type::k_double:
            case bsoncxx::type::k_codewscope:
            case bsoncxx::type::k_date:
            case bsoncxx::type::k_dbpointer:
            case bsoncxx::type::k_document:
            case bsoncxx::type::k_maxkey:
            case bsoncxx::type::k_minkey:
            case bsoncxx::type::k_null:
            case bsoncxx::type::k_regex:
            case bsoncxx::type::k_symbol:
            case bsoncxx::type::k_timestamp:
            case bsoncxx::type::k_undefined:
                // Casual lower-case message is what Mongo returns.
                ss << "can't use a " << bsoncxx::to_string(element.type()) << " for _id";
                throw std::runtime_error(ss.str());
            }
        }
        else
        {
            // If the document does contain an _id, we generate one.
            ss << "'" << bsoncxx::oid().to_string() << "'";
        }

        return ss.str();
    }

    mutable int64_t m_nDocuments { 0 };
};


// https://docs.mongodb.com/manual/reference/command/resetError/

// https://docs.mongodb.com/manual/reference/command/update/
class Update : public OrderedCommand
{
public:
    template<class ConcretePacket>
    Update(const std::string& name,
           Database* pDatabase,
           GWBUF* pRequest,
           const ConcretePacket& req,
           const bsoncxx::document::view& doc,
           const DocumentArguments& arguments)
        : OrderedCommand(name, pDatabase, pRequest, req, doc, arguments, key::UPDATES)
    {
    }

private:
    string convert_document(const bsoncxx::document::view& update)
    {
        stringstream sql;
        sql << "UPDATE " << get_table(key::UPDATE) << " SET DOC = ";

        auto u = update[key::U];

        if (!u)
        {
            throw SoftError("BSON field 'update.updates.u' is missing but a required field",
                            error::LOCATION40414);
        }

        switch (get_update_kind(u))
        {
        case AGGREGATION_PIPELINE:
            {
                string message("Aggregation pipeline not supported: '");
                message += bsoncxx::to_json(update);
                message += "'.";

                MXS_ERROR("%s", message.c_str());
                throw HardError(message, error::COMMAND_FAILED);
            }
            break;

        case REPLACEMENT_DOCUMENT:
            sql << "'"
                << bsoncxx::to_json(static_cast<bsoncxx::document::view>(u.get_document()))
                << "'";
            break;

        case UPDATE_OPERATORS:
            {
                auto doc = static_cast<bsoncxx::document::view>(u.get_document());
                sql << translate_update_operations(doc);
            }
            break;

        case INVALID:
            {
                string message("Invalid combination of updates: '");
                message += bsoncxx::to_json(update);
                message += "'.";

                MXS_ERROR("%s", message.c_str());
                throw HardError(message, error::COMMAND_FAILED);
            }
        }

        auto q = update[key::Q];

        if (!q)
        {
            throw SoftError("BSON field 'update.updates.q' is missing but a required field",
                            error::LOCATION40414);
        }

        if (q.type() != bsoncxx::type::k_document)
        {
            stringstream ss;
            ss << "BSON field 'update.updates.q' is the wrong type '" << bsoncxx::to_string(q.type())
               << "', expected type 'object'";
            throw SoftError(ss.str(), error::TYPE_MISMATCH);
        }

        sql << query_to_where_clause(q.get_document());

        auto multi = update[key::MULTI];

        if (!multi || !multi.get_bool())
        {
            sql << "LIMIT 1";
        }

        return sql.str();
    }

    enum Kind
    {
        AGGREGATION_PIPELINE,
        REPLACEMENT_DOCUMENT,
        UPDATE_OPERATORS,
        INVALID
    };

    Kind get_update_kind(const bsoncxx::document::element& element)
    {
        Kind kind = INVALID;

        switch (element.type())
        {
        case bsoncxx::type::k_array:
            kind = AGGREGATION_PIPELINE;
            break;

        case bsoncxx::type::k_document:
            {
                auto doc = static_cast<bsoncxx::document::view>(element.get_document());

                for (auto field : doc)
                {
                    const char* pData = field.key().data(); // Not necessarily null-terminated.

                    if (*pData == '$')
                    {
                        string name(pData, field.key().length());

                        if (name != "$set" && name != "$unset")
                        {
                            MXS_ERROR("'%s' contains other than the supported '$set' and '$unset' "
                                      "operations.", bsoncxx::to_json(doc).c_str());
                            kind = INVALID;
                            break;
                        }
                        else
                        {
                            if (kind == INVALID)
                            {
                                kind = UPDATE_OPERATORS;
                            }
                            else if (kind != UPDATE_OPERATORS)
                            {
                                MXS_ERROR("'%s' contains both fields and update operators.",
                                          bsoncxx::to_json(doc).c_str());
                                kind = INVALID;
                                break;
                            }
                        }
                    }
                    else
                    {
                        if (kind == INVALID)
                        {
                            kind = REPLACEMENT_DOCUMENT;
                        }
                        else if (kind != REPLACEMENT_DOCUMENT)
                        {
                            MXS_ERROR("'%s' contains both fields and update operators.",
                                      bsoncxx::to_json(doc).c_str());
                            kind = INVALID;
                            break;
                        }
                    }
                }
            }
            break;

        default:
            throw SoftError("Update argument must be either an object or an array", error::FAILED_TO_PARSE);
        }

        return kind;
    }

    string translate_update_operations(const bsoncxx::document::view& doc)
    {
        string rv;

        for (auto element : doc)
        {
            if (!rv.empty())
            {
                rv += ", ";
            }

            if (element.key().compare("$set") == 0)
            {
                rv += "JSON_SET(doc, ";
            }
            else if (element.key().compare("$unset") == 0)
            {
                rv += "JSON_REMOVE(doc, ";
            }
            else
            {
                mxb_assert(!true);
            }

            auto fields = static_cast<bsoncxx::document::view>(element.get_document());

            string s;
            for (auto field : fields)
            {
                if (!s.empty())
                {
                    s += ", ";
                }

                s += "'$.";
                s += field.key().data();
                s += "', ";
                s += to_string(field);
            }

            rv += s;

            rv += ")";
        }

        rv += " ";

        return rv;
    }

    void interpret(const ComOK& response)
    {
        m_nModified += response.affected_rows();

        string s = response.info().to_string();

        if (s.find("Rows matched: ") == 0)
        {
            m_n += atol(s.c_str() + 14);
        }
    }

    void amend_response(DocumentBuilder& doc)
    {
        doc.append(kvp("nModified", m_nModified));
    }


private:
    int32_t m_nModified { 0 };
};


}

}