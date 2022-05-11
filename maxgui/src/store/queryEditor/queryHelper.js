/*
 * Copyright (c) 2020 MariaDB Corporation Ab
 *
 * Use of this software is governed by the Business Source License included
 * in the LICENSE.TXT file and at www.mariadb.com/bsl11.
 *
 * Change Date: 2026-04-08
 *
 * On the date above, in accordance with the Business Source License, use
 * of this software will be governed by version 2 or later of the General
 * Public License.
 */
import { immutableUpdate } from 'utils/helpers'
import { APP_CONFIG } from 'utils/constants'

/**
 * @private
 * @param {String} payload.dbName - Database name to be found
 * @param {Array} payload.db_tree - Array of tree node
 * @returns {Number} index of target db
 */
const getDbIdx = ({ dbName, db_tree }) => db_tree.findIndex(db => db.name === dbName)

/**
 * @private
 * @param {String} payload.dbIdx - database index having the child
 * @param {Array} payload.db_tree - Array of tree node
 *  @param {Array} payload.childType - Children type of the database node. i.e. Tables||Stored Procedures
 * @returns {Number} index of Tables or Stored Procedures
 */
const getIdxOfDbChildNode = ({ dbIdx, db_tree, childType }) =>
    db_tree[dbIdx].children.findIndex(dbChildrenNode => dbChildrenNode.type === childType)

/**
 * @public
 * @param {String} prefixName - prefix name of the connection cookie. i.e. conn_id_body_
 * @returns {Array} an array of connection ids found from cookies
 */
function getClientConnIds(prefixName = 'conn_id_body_') {
    let value = '; ' + document.cookie
    let cookiesStr = value.split('; ')
    const connCookies = cookiesStr.filter(p => p.includes(prefixName))
    const connIds = []
    connCookies.forEach(str => {
        const parts = str.split('=')
        if (parts.length === 2) connIds.push(parts[0].replace(prefixName, ''))
    })
    return connIds
}

/**
 * @public
 * Use this function to update database node children. i.e. Populating children for
 * Tables||Stored Procedures node
 * @param {Array} payload.db_tree - Array of tree node to be updated
 * @param {String} payload.dbName - Database name
 * @param {String} payload.childType - Child type of the node to be updated. i.e. Tables||Stored Procedures
 * @param {Array} payload.gch - Array of grand child nodes (Table|Store Procedure) to be added
 * @returns {Array} new array of db_tree
 */
function updateDbChild({ db_tree, dbName, childType, gch }) {
    try {
        const dbIdx = getDbIdx({ dbName, db_tree })
        // Tables or Stored Procedures node
        const childIndex = getIdxOfDbChildNode({ dbIdx, db_tree, childType })
        const new_db_tree = immutableUpdate(db_tree, {
            [dbIdx]: { children: { [childIndex]: { children: { $set: gch } } } },
        })
        return new_db_tree
    } catch (e) {
        return {}
    }
}

/**
 * @public
 * Use this function to update table node children. i.e. Populating children for
 * `Columns` node or `Triggers` node
 * @param {Array} payload.db_tree - Array of tree node to be updated
 * @param {String} payload.dbName - Database name
 * @param {String} payload.tblName - Table name
 * @param {String} payload.childType Child type of the node to be updated. i.e. Columns or Triggers node
 * @param {Array} payload.gch -  Array of grand child nodes (column or trigger)
 * @returns {Array} new array of db_tree
 */
function updateTblChild({ db_tree, dbName, tblName, gch, childType }) {
    try {
        const dbIdx = getDbIdx({ dbName, db_tree })
        // idx of Tables node
        const idxOfTablesNode = getIdxOfDbChildNode({
            dbIdx,
            db_tree,
            childType: APP_CONFIG.SQL_NODE_TYPES.TABLES,
        })
        const tblIdx = db_tree[dbIdx].children[idxOfTablesNode].children.findIndex(
            tbl => tbl.name === tblName
        )

        const dbChildNodes = db_tree[dbIdx].children // Tables and Stored Procedures nodes
        const tblNode = dbChildNodes[idxOfTablesNode].children[tblIdx] // a table node
        // Columns and Triggers node
        const idxOfChild = tblNode.children.findIndex(node => node.type === childType)

        const new_db_tree = immutableUpdate(db_tree, {
            [dbIdx]: {
                children: {
                    [idxOfTablesNode]: {
                        children: {
                            [tblIdx]: {
                                children: {
                                    [idxOfChild]: { children: { $set: gch } },
                                },
                            },
                        },
                    },
                },
            },
        })
        return new_db_tree
    } catch (e) {
        return {}
    }
}

/**
 * @public
 * @param {Object} active_sql_conn - current connecting resource
 * @param {String} nodeId - node id .i.e schema_name.tbl_name
 * @param {Object} vue - vue instance
 * @param {Object} $queryHttp - $queryHttp axios instance
 * @returns {Object} - returns object row data
 */
async function queryTblOptsData({ active_sql_conn, nodeId, vue, $queryHttp }) {
    const schemas = nodeId.split('.')
    const db = schemas[0]
    const tblName = schemas[1]
    const cols =
        // eslint-disable-next-line vue/max-len
        'table_name, ENGINE as table_engine, character_set_name as table_charset, table_collation, table_comment'
    const sql = `SELECT ${cols} FROM information_schema.tables t
JOIN information_schema.collations c ON t.table_collation = c.collation_name
WHERE table_schema = "${db}" AND table_name = "${tblName}";`
    let tblOptsRes = await $queryHttp.post(`/sql/${active_sql_conn.id}/queries`, {
        sql,
    })
    const tblOptsRows = vue.$help.getObjectRows({
        columns: tblOptsRes.data.data.attributes.results[0].fields,
        rows: tblOptsRes.data.data.attributes.results[0].data,
    })
    return tblOptsRows[0]
}
/**
 * @public
 * @param {Object} active_sql_conn - current connecting resource
 * @param {String} nodeId - node id .i.e schema_name.tbl_name
 * @param {Object} $queryHttp - $queryHttp axios instance
 * @returns {Object} - returns object data contains `data` and `fields`
 */
async function queryColsOptsData({ active_sql_conn, nodeId, $queryHttp }) {
    const schemas = nodeId.split('.')
    const db = schemas[0]
    const tblName = schemas[1]
    /**
     * Exception for UQ column
     * It needs to LEFT JOIN statistics and table_constraints tables to get accurate UNIQUE INDEX from constraint_name.
     * LEFT JOIN statistics as it has column_name, index_name
     * LEFT JOIN table_constraints as it has constraint_name. There is a sub-query in table_constraints to get
     * get only rows having constraint_type = 'UNIQUE'.
     * Notice: UQ column returns UNIQUE INDEX name.
     *
     */
    const cols = `
    UUID() AS id,
    a.column_name,
    REGEXP_SUBSTR(UPPER(column_type), '[^)]*[)]?') AS column_type,
    IF(column_key LIKE '%PRI%', 'YES', 'NO') as PK,
    IF(is_nullable LIKE 'YES', 'NULL', 'NOT NULL') as NN,
    IF(column_type LIKE '%UNSIGNED%', 'UNSIGNED', '') as UN,
    IF(c.constraint_name IS NULL, '', c.constraint_name) as UQ,
    IF(column_type LIKE '%ZEROFILL%', 'ZEROFILL', '') as ZF,
    IF(extra LIKE '%AUTO_INCREMENT%', 'AUTO_INCREMENT', '') as AI,
    IF(
        UPPER(extra) REGEXP 'VIRTUAL|STORED',
        REGEXP_SUBSTR(UPPER(extra), 'VIRTUAL|STORED'),
        '(none)'
     ) AS generated,
    COALESCE(generation_expression, column_default, '') as 'default/expression',
    IF(character_set_name IS NULL, '', character_set_name) as charset,
    IF(collation_name IS NULL, '', collation_name) as collation,
    column_comment as comment
    `
    const colsOptsRes = await $queryHttp.post(`/sql/${active_sql_conn.id}/queries`, {
        sql: `
        SELECT ${cols} FROM information_schema.columns a
            LEFT JOIN information_schema.statistics b ON (
                a.table_schema = b.table_schema
                AND a.table_name = b.table_name
                AND a.column_name = b.column_name
            )
            LEFT JOIN (
                SELECT
                    table_name, table_schema, constraint_name
                FROM
                    information_schema.table_constraints
                WHERE
                    constraint_type = 'UNIQUE'
            ) c ON (
                a.table_name = c.table_name
                AND a.table_schema = c.table_schema
                AND b.index_name = c.constraint_name
            )
        WHERE
            a.table_schema='${db}'
            AND a.table_name='${tblName}'
        GROUP BY a.column_name
        ORDER BY a.ordinal_position;`,
    })
    return colsOptsRes.data.data.attributes.results[0]
}

/**
 * @private
 * This helps to mutate flat state
 * @param {Object} moduleState  module state to be mutated
 * @param {Object} data  key/value state, can be more than one key
 */
function mutate_flat_states({ moduleState, data }) {
    Object.keys(data).forEach(key => (moduleState[key] = data[key]))
}
/**
 * @public
 * This function helps to synchronize persistedObj in the persisted array. e.g. worksheets_arr with provided data
 * @param {Object} param.scope - Mutation scope.
 * @param {Object} param.data - partial modification of a persistedObj in the persisted array
 * @param {Object} param.id - id of a persistedObj in the persisted array
 * @param {String} param.persistedArrayPath - module path to persisted array state .e.g. `wke.worksheets_arr`
 */
export function syncToPersistedObj({ scope, data, id, persistedArrayPath }) {
    const {
        state,
        vue: {
            $help: {
                lodash: { objectSet },
                immutableUpdate,
            },
            $typy,
        },
    } = scope
    const persistedArray = $typy(state, persistedArrayPath).safeArray
    const idx = persistedArray.findIndex(obj => obj.id === id)
    objectSet(
        state, //obj
        persistedArrayPath, //path
        //new value
        immutableUpdate(persistedArray, {
            [idx]: { $set: { ...persistedArray[idx], ...data } },
        })
    )
}

/**
 * @public
 * The value of each state is replicated from the persisted object in the
 * persisted array. e.g. worksheets_arr
 * Using this to reduce unnecessary recomputation instead of
 * directly accessing the value in the persisted array because vuex getters
 * or vue.js computed properties will recompute when a property
 * is changed in persisted array then causes other properties also
 * have to recompute. A better method would be to create relational
 * keys between modules, but for now, stick with the old approach.
 * @param {String} namespace -  module namespace. i.e. editor, queryConn, queryResult, schemaSidebar
 * @returns {Object} - return flat state for the provided namespace module
 */
function syncStateCreator(namespace) {
    switch (namespace) {
        case 'editor':
            return { query_txt: '', curr_ddl_alter_spec: '' }
        case 'queryConn':
            return { active_sql_conn: {} }
        case 'queryResult':
            return { curr_query_mode: 'QUERY_VIEW', show_vis_sidebar: false }
        case 'schemaSidebar':
            return {
                is_sidebar_collapsed: false,
                search_schema: '',
                active_db: '',
                expanded_nodes: [],
            }
        default:
            return null
    }
}
/**
 * @public
 * This function helps to generate vuex mutations for states to by mutated to
 * flat states and synced to persistedObj.
 * The name of mutation follows this pattern SET_STATE_NAME.
 * e.g. Mutation for active_sql_conn state is SET_ACTIVE_SQL_CONN
 * @param {Object} param.statesToBeSynced. states to be mutated and synced
 * @param {String} param.persistedArrayPath - module path to persisted array state .e.g. `wke.worksheets_arr`
 * @returns {Object} - returns vuex mutations
 */
function syncedStateMutationsCreator({ statesToBeSynced, persistedArrayPath }) {
    return {
        // Generate mutation for each key
        ...Object.keys(statesToBeSynced).reduce(
            (mutations, key) => ({
                ...mutations,
                [`SET_${key.toUpperCase()}`]: function(state, { payload, id }) {
                    const data = {
                        [key]: payload,
                    }
                    // First mutating flat states then sync it to persistedObj
                    mutate_flat_states({ moduleState: state, data })
                    syncToPersistedObj({ scope: this, data, id, persistedArrayPath })
                },
            }),
            {}
        ),
        /**
         * Sync persistedObj to flat states
         * @param {Object} state - vuex state
         * @param {Object} persistedObj - persisted object.
         */
        SYNC_WITH_PERSISTED_OBJ: function(state, persistedObj) {
            mutate_flat_states({
                moduleState: state,
                data: this.vue.$help.lodash.pickBy(persistedObj, (v, key) =>
                    Object.keys(statesToBeSynced).includes(key)
                ),
            })
        },
    }
}

/**
 * @public
 * Below states are stored in hash map structure.
 * The state uses worksheet id as key or session id. This helps to preserve
 * multiple worksheet's data or session's data in memory.
 * Use `memStatesMutationCreator` to create corresponding mutations
 * @param {String} namespace -  module namespace. i.e. editor, queryConn, queryResult, schemaSidebar
 * @returns {Object} - returns states that are stored in memory
 */
function memStateCreator(namespace) {
    switch (namespace) {
        case 'editor':
            return {
                /**
                 * each key holds these properties:
                 * value?: string. Check SQL_EDITOR_MODES
                 */
                curr_editor_mode_map: {},
                /**
                 * each key holds these properties:
                 * altered_active_node?: object
                 * loading_tbl_creation_info?: boolean
                 * data:{ table_opts_data?: object, cols_opts_data?: object }
                 */
                tbl_creation_info_map: {},
            }
        case 'queryConn':
            return {
                /**
                 * each key holds these properties:
                 * value?: boolean
                 */
                is_conn_busy_map: {},
                /**
                 * each key holds these properties:
                 * value?: object
                 */
                lost_cnn_err_msg_obj_map: {},
            }
        case 'queryResult':
            return {
                /**
                 * each key holds these properties:
                 * request_sent_time?: number
                 * total_duration?: number
                 * loading_prvw_data?: boolean,
                 * data? object
                 */
                prvw_data_map: {},
                /**
                 * each key holds these properties:
                 * request_sent_time?: number
                 * total_duration?: number
                 * loading_prvw_data_details?: boolean,
                 * data? object
                 */
                prvw_data_details_map: {},
                /**
                 * each key holds these properties:
                 * request_sent_time?: number
                 * total_duration?: number
                 * loading_query_result?: boolean,
                 * data? object.
                 */
                query_results_map: {},
                /**
                 * each key holds these properties:
                 * value?: boolean
                 */
                is_stopping_query_map: {},
            }
        case 'schemaSidebar':
            return {
                /**
                 * each key holds these properties:
                 * loading_db_tree?: boolean
                 * db_completion_list?: array,
                 * data? array. Contains schemas array
                 * active_tree_node? object. Contains active node in the schemas array
                 */
                db_tree_map: {},
                /**
                 * each key holds these properties:
                 * data? object. Contains res.data.data.attributes of a query
                 * stmt_err_msg_obj? object.
                 * result?: array. error msg array.
                 */
                exe_stmt_result_map: {},
            }
        default:
            return null
    }
}
/**
 * @public
 * Mutations creator for states storing in hash map structure (storing in memory).
 * The state uses worksheet id as key or session id. This helps to preserve multiple worksheet's
 * data or session's data in memory.
 * The name of mutation follows this pattern PATCH_STATE_NAME.
 * e.g. Mutation for is_conn_busy_map state is PATCH_IS_CONN_BUSY_MAP
 * @param {Object} param.memStates - memStates storing in memory
 * @returns {Object} - returns mutations for provided memStates
 */
function memStatesMutationCreator(memStates) {
    return Object.keys(memStates).reduce((mutations, stateName) => {
        return {
            ...mutations,
            /**
             * if payload is not provided, the id (wke_id or session_id) key will be removed from the map
             * @param {String} param.id - wke_id or session_id
             * @param {Object} param.payload - always an object
             */
            [`PATCH_${stateName.toUpperCase()}`]: function(state, { id, payload }) {
                if (!payload) this.vue.$delete(state[stateName], id)
                else {
                    state[stateName] = {
                        ...state[stateName],
                        ...{ [id]: { ...state[stateName][id], ...payload } },
                    }
                }
            },
        }
    }, {})
}
/**
 * @public
 * This helps to commit mutations to release data storing in memory
 * @param {Object} param.namespace - module namespace. i.e. editor, queryConn, queryResult, schemaSidebar
 * @param {Function} param.commit - vuex commit function
 * @param {String} param.id - wke_id or session_id
 * @param {Object} param.memStates - memStates storing in memory
 */
function releaseMemory({ namespace, commit, id, memStates }) {
    Object.keys(memStates).forEach(key => {
        commit(`${namespace}/PATCH_${key.toUpperCase()}`, { id }, { root: true })
    })
}

export default {
    getClientConnIds,
    updateDbChild,
    updateTblChild,
    queryTblOptsData,
    queryColsOptsData,
    syncStateCreator,
    syncedStateMutationsCreator,
    memStateCreator,
    memStatesMutationCreator,
    releaseMemory,
    syncToPersistedObj,
}
