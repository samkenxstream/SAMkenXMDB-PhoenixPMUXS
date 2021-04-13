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

class OrderedCommand : public MultiCommand
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
        : MultiCommand(name, pDatabase, pRequest, req, doc, arguments)
        , m_key(array_key)
    {
    }

public:
    GWBUF* execute() override final
    {
        m_statements = generate_sql();

        m_it = m_statements.begin();

        execute_one_statement();

        return nullptr;
    }

    State translate(GWBUF& mariadb_response, GWBUF** ppResponse) override
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
    std::vector<std::string> generate_sql() override final
    {
        std::vector<std::string> statements;

        optional(key::ORDERED, &m_ordered);

        auto it = m_arguments.find(m_key);

        if (it != m_arguments.end())
        {
            const auto& documents = it->second;
            check_write_batch_size(documents.size());

            for (auto doc : documents)
            {
                statements.push_back(convert_document(doc));
            }
        }
        else
        {
            auto documents = required<bsoncxx::array::view>(m_key.c_str());
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

                statements.push_back(convert_document(element.get_document()));
            }
        }

        return statements;
    }

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

// https://docs.mongodb.com/manual/reference/command/delete/
class Delete final : public OrderedCommand
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

        sql << "DELETE FROM " << table() << " ";

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
class Find final : public SingleCommand
{
public:
    using SingleCommand::SingleCommand;

    string generate_sql() override
    {
        stringstream sql;
        sql << "SELECT ";

        bsoncxx::document::view projection;
        if (optional(key::PROJECTION, &projection))
        {
            m_extractions = projection_to_extractions(projection);

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

        sql << " FROM " << table() << " ";

        bsoncxx::document::view filter;
        if (optional(key::FILTER, &filter))
        {
            sql << query_to_where_clause(filter);
        }

        bsoncxx::document::view sort;
        if (optional(key::SORT, &sort))
        {
            string order_by = sort_to_order_by(sort);

            MXS_NOTICE("Sort '%s' converted to 'ORDER BY %s'.",
                       bsoncxx::to_json(sort).c_str(),
                       order_by.c_str());

            if (!order_by.empty())
            {
                sql << "ORDER BY " << order_by << " ";
            }
        }

        sql << convert_skip_and_limit();

        return sql.str();
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

                    pResponse = MariaDBError(err).create_response(*this);
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
class Insert final : public OrderedCommand
{
public:
    template<class ConcretePacket>
    Insert(const std::string& name,
           Database* pDatabase,
           GWBUF* pRequest,
           const ConcretePacket& req,
           const bsoncxx::document::view& doc,
           const DocumentArguments& arguments)
        : OrderedCommand(name, pDatabase, pRequest, req, doc, arguments, key::DOCUMENTS)
    {
    }

    using OrderedCommand::OrderedCommand;

    using Worker = mxb::Worker;

    ~Insert()
    {
        if (m_dcid)
        {
            Worker::get_current()->cancel_delayed_call(m_dcid);
        }
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
                state = OrderedCommand::translate(mariadb_response, &pResponse);
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
                                   << table()
                                   << " (id TEXT NOT NULL UNIQUE, doc JSON)";

                                send_downstream(ss.str());
                            }

                            return false;
                        });
                }
                else
                {
                    stringstream ss;
                    ss << "Table " << table() << " does not exist, and 'auto_create_tables' "
                       << "is false.";

                    pResponse = HardError(ss.str(), error::COMMAND_FAILED).create_response(*this);
                    state = READY;
                }
            }
        }
        else
        {
            mxb_assert(m_mode == TABLE_CREATING);

            switch (response.type())
            {
            case ComResponse::OK_PACKET:
                MXS_NOTICE("TABLE created, now executing statment.");
                m_mode = NORMAL;
                execute_one_statement();
                break;

            case ComResponse::ERR_PACKET:
                {
                    ComERR err(response);

                    auto code = err.code();

                    if (code == ER_TABLE_EXISTS_ERROR)
                    {
                        MXS_NOTICE("TABLE created by someone else, now executing statment.");
                        m_mode = NORMAL;
                        execute_one_statement();
                    }
                    else
                    {
                        MXS_ERROR("Could not create table: (%d), %s", err.code(), err.message().c_str());
                        pResponse = MariaDBError(err).create_response(*this);
                        state = READY;
                    }
                }
                break;

            default:
                mxb_assert(!true);
                MXS_ERROR("Expected OK or ERR packet, received something else.");
                pResponse = HardError("Unexpected response received from backend.",
                                      error::COMMAND_FAILED).create_response(*this);
                state = READY;
            }
        }

        mxb_assert((state == BUSY && pResponse == nullptr) || (state == READY && pResponse != nullptr));
        *ppResponse = pResponse;
        return state;
    }

protected:
    string convert_document(const bsoncxx::document::view& doc) override
    {
        stringstream sql;
        sql << "INSERT INTO " << table() << " (id, doc) VALUES ";

        sql << "(";

        string id;
        string json;
        auto element = doc["_id"];

        if (element)
        {
            id = get_id(element);
            json = bsoncxx::to_json(doc);
        }
        else
        {
            // Ok, as the document does not have an id, one must be generated. However,
            // as an existing document is immutable, a new one must be created.

            bsoncxx::oid oid;

            DocumentBuilder builder;
            builder.append(kvp("_id", oid));

            for (const auto& e : doc)
            {
                append(builder, e.key(), element);
            }

            auto doc_with_id = builder.extract();

            id = "'" + oid.to_string() + "'";
            json = bsoncxx::to_json(doc_with_id);
        }

        sql << id;
        sql << ", '";
        sql << json;
        sql << "'";

        sql << ")";

        return sql.str();
    }

    static string get_id(const bsoncxx::document::element& element)
    {
        return "'" + mxsmongo::to_string(element) + "'";
    }

    void interpret(const ComOK& response)
    {
        m_n += response.affected_rows();
    }

    enum Mode
    {
        NORMAL,
        TABLE_CREATING,
    };

    Mode            m_mode { NORMAL };
    uint32_t        m_dcid { 0 };
    mutable int64_t m_nDocuments { 0 };
};


// https://docs.mongodb.com/manual/reference/command/resetError/

// https://docs.mongodb.com/manual/reference/command/update/
class Update final : public OrderedCommand
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
        sql << "UPDATE " << table() << " SET DOC = ";

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
                s += mxsmongo::to_value(field);
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
