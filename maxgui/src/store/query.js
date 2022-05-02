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
import { uniqBy, uniqueId, pickBy } from 'utils/helpers'
import queryHelper from './queryHelper'
import { connStatesToBeSynced } from './queryConn'
/**
 * @returns Initial sidebar tree schema related states
 */
export function sidebarStates() {
    return {
        is_sidebar_collapsed: false,
        search_schema: '',
        active_db: '',
        expanded_nodes: [],
    }
}
/**
 * @returns Initial editor related states
 */
export function editorStates() {
    return {
        query_txt: '',
        curr_ddl_alter_spec: '',
    }
}
/**
 * @returns Initial result related states
 */
export function resultStates() {
    return {
        curr_query_mode: 'QUERY_VIEW',
    }
}
/**
 * @returns Initial toolbar related states
 */
export function toolbarStates() {
    return {
        // toolbar's states
        show_vis_sidebar: false,
    }
}

/**
 * @returns Return initial worksheet synchronized states
 */
function wkeStatesToBeSynced() {
    return {
        ...sidebarStates(),
        ...editorStates(),
        ...resultStates(),
        ...toolbarStates(),
    }
}

/**
 * @returns Return a new worksheet state with unique id
 */
export function defWorksheetState() {
    return {
        id: uniqueId(`${new Date().getUTCMilliseconds()}_`),
        name: 'WORKSHEET',
        ...wkeStatesToBeSynced(),
        ...connStatesToBeSynced(),
    }
}
/**
 * Below states are stored in hash map structure.
 * Using worksheet's id as key. This helps to preserve
 * multiple worksheet's data in memory.
 * Use `queryHelper.memStatesMutationCreator` to create corresponding mutations
 * Some keys will have mutation name starts with either `SET` or `PATCH`
 * prefix. Check getMemStateMutationTypes for more info
 * @returns {Object} - returns states that are stored in memory
 */
function memStates() {
    return {
        // connection related states
        is_querying_map: {},
        lost_cnn_err_msg_obj_map: {},
        // sidebar states
        db_tree_map: {},
        exe_stmt_result_map: {},
        // editor states
        curr_editor_mode_map: {},
        tbl_creation_info_map: {},
        // results states
        prvw_data_map: {},
        prvw_data_details_map: {},
        query_results_map: {},
        is_stopping_query_map: {},
    }
}
function getMemStateMutationTypes() {
    const keysWithPrefixSet = [
        'is_querying_map',
        'lost_cnn_err_msg_obj_map',
        'curr_editor_mode_map',
        'is_stopping_query_map',
    ]
    return Object.keys(memStates()).reduce((res, key) => {
        return { ...res, [key]: keysWithPrefixSet.includes(key) ? 'SET' : 'PATCH' }
    }, {})
}

export default {
    namespaced: true,
    state: {
        // Toolbar states
        is_fullscreen: false,
        // editor states
        charset_collation_map: new Map(),
        def_db_charset_map: new Map(),
        engines: [],
        selected_query_txt: '',
        // worksheet states
        worksheets_arr: [defWorksheetState()], // persisted
        active_wke_id: '',
        ...memStates(),
        /**
         * Below is standalone wke states. The value
         * of each state is replicated from current active
         * worksheet in persisted worksheets_arr.
         * Using this to reduce unnecessary recomputation instead of
         * directly accessing value in worksheets_arr because vuex getters
         * or vue.js's computed properties will recompute when a property
         * is changed in worksheets_arr then causes other properties also
         * have to recompute.
         */
        ...wkeStatesToBeSynced(),
    },
    mutations: {
        ...queryHelper.memStatesMutationCreator({ mutationTypesMap: getMemStateMutationTypes() }),
        ...queryHelper.syncedStateMutationsCreator(wkeStatesToBeSynced()),
        //Toolbar mutations
        SET_FULLSCREEN(state, payload) {
            state.is_fullscreen = payload
        },
        // editor mutations
        SET_SELECTED_QUERY_TXT(state, payload) {
            state.selected_query_txt = payload
        },
        SET_CHARSET_COLLATION_MAP(state, payload) {
            state.charset_collation_map = payload
        },
        SET_DEF_DB_CHARSET_MAP(state, payload) {
            state.def_db_charset_map = payload
        },
        SET_ENGINES(state, payload) {
            state.engines = payload
        },
        // worksheet mutations
        ADD_NEW_WKE(state) {
            state.worksheets_arr.push(defWorksheetState())
        },
        DELETE_WKE(state, idx) {
            state.worksheets_arr.splice(idx, 1)
        },
        UPDATE_WKE(state, { idx, wke }) {
            state.worksheets_arr = this.vue.$help.immutableUpdate(state.worksheets_arr, {
                [idx]: { $set: wke },
            })
        },
        SET_ACTIVE_WKE_ID(state, payload) {
            state.active_wke_id = payload
        },
        /**
         * When active_wke_id is changed, call this to sync properties from worksheets_arr
         * back to wkeStatesToBeSynced in this module
         * @param {Object} state - vuex state
         * @param {Object} wke - wke object
         */
        SYNC_WKE_STATES(state, wke) {
            queryHelper.mutateFlatStates({
                moduleState: state,
                data: pickBy(wke, (v, key) => Object.keys(wkeStatesToBeSynced()).includes(key)),
            })
        },
    },
    actions: {
        chooseActiveWke({ state, commit, dispatch }) {
            const { type = 'blank_wke', id: paramId } = this.router.app.$route.params
            if (paramId) {
                if (type !== 'blank_wke') {
                    /**
                     * Check if there is a worksheet connected to the provided resource id (paramId)
                     * then if it's not the current active worksheet, change current worksheet tab to targetWke.
                     * Otherwise, find an empty worksheet(has not been bound to a connection), set it as active and
                     * dispatch SET_PRE_SELECT_CONN_RSRC to open connection dialog
                     */
                    const targetWke = state.worksheets_arr.find(
                        w => w.active_sql_conn.name === paramId
                    )
                    if (targetWke) commit('SET_ACTIVE_WKE_ID', targetWke.id)
                    else {
                        // Use a blank wke if there is one, otherwise create a new one
                        const blankWke = state.worksheets_arr.find(
                            wke => this.vue.$typy(wke, 'active_sql_conn').isEmptyObject
                        )
                        if (blankWke) commit('SET_ACTIVE_WKE_ID', blankWke.id)
                        else dispatch('addNewWs')
                        commit(
                            'queryConn/SET_PRE_SELECT_CONN_RSRC',
                            { type, id: paramId },
                            { root: true }
                        )
                    }
                }
            } else if (state.worksheets_arr.length) {
                const currActiveWkeId = state.active_wke_id
                const nextActiveWkeId = state.worksheets_arr[0].id
                // set the first wke as active if route param id is not specified
                commit('SET_ACTIVE_WKE_ID', state.worksheets_arr[0].id)
                if (currActiveWkeId === nextActiveWkeId) dispatch('updateRoute', nextActiveWkeId)
            }
        },
        /**
         * This handles updating route for the current active worksheet.
         * If it is bound to a connection, it navigates route to the nested route. i.e /query/:resourceType/:resourceId
         * Otherwise, it uses worksheet id as nested route id. i.e. /query/blank_wke/:wkeId.
         * This function must be called in the following cases:
         * 1. When $route changes. e.g. The use edits url or enter page with an absolute link
         * 2. When active_wke_id is changed. e.g. The user creates new worksheet or navigate between worksheets
         * 3. When active_sql_conn is changed. e.g. The user selects connection in the dropdown or opens new one
         * 4. When the connection is unlinked from the worksheet
         * @param {String} wkeId - worksheet id
         */
        updateRoute({ state }, wkeId) {
            let from = this.router.app.$route.path,
                to = `/query/blank_wke/${wkeId}`
            const targetWke = state.worksheets_arr.find(w => w.id === wkeId)
            const { type, name } = targetWke.active_sql_conn
            if (name) to = `/query/${type}/${name}`
            if (from !== to) this.router.push(to)
        },
        /**
         * @param {Object} chosenConn  Chosen connection
         */
        async initialFetch({ dispatch }, chosenConn) {
            await dispatch('reloadTreeNodes')
            await dispatch('updateActiveDb')
            dispatch('changeWkeName', chosenConn.name)
        },
        addNewWs({ commit, state }) {
            try {
                commit('ADD_NEW_WKE')
                commit(
                    'SET_ACTIVE_WKE_ID',
                    state.worksheets_arr[state.worksheets_arr.length - 1].id
                )
            } catch (e) {
                const logger = this.vue.$logger('store-query-addNewWs')
                logger.error(e)
                commit(
                    'SET_SNACK_BAR_MESSAGE',
                    {
                        text: [this.i18n.t('errors.persistentStorage')],
                        type: 'error',
                    },
                    { root: true }
                )
            }
        },
        handleDeleteWke({ state, commit, dispatch }, wkeIdx) {
            const targetWke = state.worksheets_arr[wkeIdx]
            dispatch('releaseMemory', targetWke.id)
            commit('DELETE_WKE', wkeIdx)
        },
        /**
         *
         * @param {Object} payload.state  query module state
         * @returns {Object} { dbTree, cmpList }
         */
        async getDbs({ rootState }) {
            const active_sql_conn = rootState.queryConn.active_sql_conn
            try {
                const {
                    SQL_NODE_TYPES: { SCHEMA, TABLES, SPS },
                    SQL_SYS_SCHEMAS: SYS_S,
                } = rootState.app_config
                let sql = 'SELECT * FROM information_schema.SCHEMATA'
                if (!rootState.persisted.query_show_sys_schemas_flag)
                    sql += ` WHERE SCHEMA_NAME NOT IN(${SYS_S.map(db => `'${db}'`).join(',')})`
                const res = await this.$queryHttp.post(`/sql/${active_sql_conn.id}/queries`, {
                    sql,
                })
                let cmpList = []
                let db_tree = []
                if (res.data.data.attributes.results[0].data) {
                    const dataRows = this.vue.$help.getObjectRows({
                        columns: res.data.data.attributes.results[0].fields,
                        rows: res.data.data.attributes.results[0].data,
                    })
                    dataRows.forEach(row => {
                        db_tree.push({
                            key: uniqueId('node_key_'),
                            type: SCHEMA,
                            name: row.SCHEMA_NAME,
                            id: row.SCHEMA_NAME,
                            data: row,
                            draggable: true,
                            level: 0,
                            isSys: SYS_S.includes(row.SCHEMA_NAME.toLowerCase()),
                            children: [
                                {
                                    key: uniqueId('node_key_'),
                                    type: TABLES,
                                    name: TABLES,
                                    // only use to identify active node
                                    id: `${row.SCHEMA_NAME}.${TABLES}`,
                                    draggable: false,
                                    level: 1,
                                    children: [],
                                },
                                {
                                    key: uniqueId('node_key_'),
                                    type: SPS,
                                    name: SPS,
                                    // only use to identify active node
                                    id: `${row.SCHEMA_NAME}.${SPS}`,
                                    draggable: false,
                                    level: 1,
                                    children: [],
                                },
                            ],
                        })
                        cmpList.push({
                            label: row.SCHEMA_NAME,
                            detail: 'SCHEMA',
                            insertText: `\`${row.SCHEMA_NAME}\``,
                            type: SCHEMA,
                        })
                    })
                }
                return { db_tree, cmpList }
            } catch (e) {
                const logger = this.vue.$logger('store-query-getDbs')
                logger.error(e)
            }
        },
        /**
         * @param {Object} node - node child of db node object. Either type TABLES or SPS
         * @returns {Object} { dbName, gch, cmpList }
         */
        async getDbGrandChild({ rootState }, node) {
            const active_sql_conn = rootState.queryConn.active_sql_conn
            try {
                let dbName, grandChildNodeType, rowName, query
                const {
                    SQL_NODE_TYPES: { TABLES, TABLE, SPS, SP, COLS, TRIGGERS },
                    SQL_SYS_SCHEMAS: SYS_S,
                } = rootState.app_config
                // a db node id is formed by dbName.node_type So getting dbName by removing node type part from id.
                let reg = `\\b.${node.type}\\b`
                dbName = node.id.replace(new RegExp(reg, 'g'), '')
                switch (node.type) {
                    case TABLES:
                        grandChildNodeType = TABLE
                        rowName = 'TABLE_NAME'
                        // eslint-disable-next-line vue/max-len
                        query = `SELECT TABLE_NAME, CREATE_TIME, TABLE_TYPE, TABLE_ROWS, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${dbName}';`
                        break
                    case SPS:
                        grandChildNodeType = SP
                        rowName = 'ROUTINE_NAME'
                        // eslint-disable-next-line vue/max-len
                        query = `SELECT ROUTINE_NAME, CREATED FROM information_schema.ROUTINES WHERE ROUTINE_TYPE = 'PROCEDURE' AND ROUTINE_SCHEMA = '${dbName}';`
                        break
                }
                const res = await this.$queryHttp.post(`/sql/${active_sql_conn.id}/queries`, {
                    sql: query,
                })
                const dataRows = this.vue.$help.getObjectRows({
                    columns: res.data.data.attributes.results[0].fields,
                    rows: res.data.data.attributes.results[0].data,
                })

                let gch = []
                let cmpList = []
                dataRows.forEach(row => {
                    let grandChildNode = {
                        key: uniqueId('node_key_'),
                        type: grandChildNodeType,
                        name: row[rowName],
                        id: `${dbName}.${row[rowName]}`,
                        draggable: true,
                        data: row,
                        level: 2,
                        isSys: SYS_S.includes(dbName.toLowerCase()),
                    }
                    // For child node of TABLES, it has canBeHighlighted and children props
                    if (node.type === TABLES) {
                        grandChildNode.canBeHighlighted = true
                        grandChildNode.children = [
                            {
                                key: uniqueId('node_key_'),
                                type: COLS,
                                name: COLS,
                                // only use to identify active node
                                id: `${dbName}.${row[rowName]}.${COLS}`,
                                draggable: false,
                                children: [],
                                level: 3,
                            },
                            {
                                key: uniqueId('node_key_'),
                                type: TRIGGERS,
                                name: TRIGGERS,
                                // only use to identify active node
                                id: `${dbName}.${row[rowName]}.${TRIGGERS}`,
                                draggable: false,
                                children: [],
                                level: 3,
                            },
                        ]
                    }
                    gch.push(grandChildNode)

                    cmpList.push({
                        label: row[rowName],
                        detail: grandChildNodeType.toUpperCase(),
                        insertText: `\`${row[rowName]}\``,
                        type: grandChildNodeType,
                    })
                })
                return { dbName, gch, cmpList }
            } catch (e) {
                const logger = this.vue.$logger('store-query-getDbGrandChild')
                logger.error(e)
            }
        },
        /**
         * @param {Object} node - node object. Either type `Triggers` or `Columns`
         * @returns {Object} { dbName, tblName, gch, cmpList }
         */
        async getTableGrandChild({ rootState }, node) {
            const active_sql_conn = rootState.queryConn.active_sql_conn
            try {
                const dbName = node.id.split('.')[0]
                const tblName = node.id.split('.')[1]
                const {
                    SQL_NODE_TYPES: { COLS, COL, TRIGGERS, TRIGGER },
                    SQL_SYS_SCHEMAS: SYS_S,
                } = rootState.app_config
                let grandChildNodeType, rowName, query
                switch (node.type) {
                    case TRIGGERS:
                        grandChildNodeType = TRIGGER
                        rowName = 'TRIGGER_NAME'
                        // eslint-disable-next-line vue/max-len
                        query = `SELECT TRIGGER_NAME, CREATED, EVENT_MANIPULATION, ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA='${dbName}' AND EVENT_OBJECT_TABLE = '${tblName}';`
                        break
                    case COLS:
                        grandChildNodeType = COL
                        rowName = 'COLUMN_NAME'
                        // eslint-disable-next-line vue/max-len
                        query = `SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY, PRIVILEGES FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = "${dbName}" AND TABLE_NAME = "${tblName}";`
                        break
                }
                const res = await this.$queryHttp.post(`/sql/${active_sql_conn.id}/queries`, {
                    sql: query,
                })

                const dataRows = this.vue.$help.getObjectRows({
                    columns: res.data.data.attributes.results[0].fields,
                    rows: res.data.data.attributes.results[0].data,
                })

                let gch = []
                let cmpList = []

                dataRows.forEach(row => {
                    gch.push({
                        key: uniqueId('node_key_'),
                        type: grandChildNodeType,
                        name: row[rowName],
                        id: `${tblName}.${row[rowName]}`,
                        draggable: true,
                        data: row,
                        level: 4,
                        isSys: SYS_S.includes(dbName.toLowerCase()),
                    })
                    cmpList.push({
                        label: row[rowName],
                        detail: grandChildNodeType.toUpperCase(),
                        insertText: row[rowName],
                        type: grandChildNodeType,
                    })
                })
                return { dbName, tblName, gch, cmpList }
            } catch (e) {
                const logger = this.vue.$logger('store-query-getTableGrandChild')
                logger.error(e)
            }
        },
        /**
         * @param {Object} payload.node - A node object having children nodes
         * @param {Array} payload.db_tree - Array of tree node to be updated
         * @param {Array} payload.cmpList - Array of completion list for editor
         * @returns {Array} { new_db_tree: {}, new_cmp_list: [] }
         */
        async getTreeData({ dispatch, rootState }, { node, db_tree, cmpList }) {
            try {
                const { TABLES, SPS, COLS, TRIGGERS } = rootState.app_config.SQL_NODE_TYPES
                switch (node.type) {
                    case TABLES:
                    case SPS: {
                        const { gch, cmpList: partCmpList, dbName } = await dispatch(
                            'getDbGrandChild',
                            node
                        )
                        const new_db_tree = queryHelper.updateDbChild({
                            db_tree,
                            dbName,
                            childType: node.type,
                            gch,
                        })
                        return { new_db_tree, new_cmp_list: [...cmpList, ...partCmpList] }
                    }
                    case COLS:
                    case TRIGGERS: {
                        const { gch, cmpList: partCmpList, dbName, tblName } = await dispatch(
                            'getTableGrandChild',
                            node
                        )
                        const new_db_tree = queryHelper.updateTblChild({
                            db_tree,
                            dbName,
                            tblName,
                            childType: node.type,
                            gch,
                        })
                        return { new_db_tree, new_cmp_list: [...cmpList, ...partCmpList] }
                    }
                }
            } catch (e) {
                const logger = this.vue.$logger('store-query-getTreeData')
                logger.error(e)
                return { new_db_tree: {}, new_cmp_list: [] }
            }
        },
        async updateTreeNodes({ commit, dispatch, state, getters }, node) {
            const active_wke_id = state.active_wke_id
            try {
                const { new_db_tree, new_cmp_list } = await dispatch('getTreeData', {
                    node,
                    db_tree: getters.getDbTreeData,
                    cmpList: getters.getDbCmplList,
                })
                commit('PATCH_DB_TREE_MAP', {
                    id: active_wke_id,
                    payload: {
                        data: new_db_tree,
                        db_completion_list: new_cmp_list,
                    },
                })
            } catch (e) {
                const logger = this.vue.$logger(`store-query-updateTreeNodes`)
                logger.error(e)
            }
        },
        async reloadTreeNodes({ commit, dispatch, state, rootState }) {
            const active_wke_id = state.active_wke_id
            const expanded_nodes = this.vue.$help.lodash.cloneDeep(state.expanded_nodes)
            try {
                commit('PATCH_DB_TREE_MAP', {
                    id: active_wke_id,
                    payload: {
                        loading_db_tree: true,
                    },
                })
                const { db_tree, cmpList } = await dispatch('getDbs')
                if (db_tree.length) {
                    let tree = db_tree
                    let completionList = cmpList
                    const { TABLES, SPS, COLS, TRIGGERS } = rootState.app_config.SQL_NODE_TYPES
                    const nodesHaveChild = [TABLES, SPS, COLS, TRIGGERS]
                    for (const node of expanded_nodes) {
                        if (nodesHaveChild.includes(node.type)) {
                            const { new_db_tree, new_cmp_list } = await dispatch('getTreeData', {
                                node,
                                db_tree: tree,
                                cmpList: completionList,
                            })
                            if (!this.vue.$typy(new_db_tree).isEmptyObject) tree = new_db_tree
                            if (completionList.length) completionList = new_cmp_list
                        }
                    }
                    commit('PATCH_DB_TREE_MAP', {
                        id: active_wke_id,
                        payload: {
                            loading_db_tree: false,
                            data: tree,
                            db_completion_list: completionList,
                        },
                    })
                }
            } catch (e) {
                commit('PATCH_DB_TREE_MAP', {
                    id: active_wke_id,
                    payload: {
                        loading_db_tree: false,
                    },
                })
                const logger = this.vue.$logger(`store-query-reloadTreeNodes`)
                logger.error(e)
            }
        },
        /**
         * @param {String} tblId - Table id (database_name.table_name).
         */
        async fetchPrvw({ state, rootState, commit, dispatch }, { tblId, prvwMode }) {
            const active_sql_conn = rootState.queryConn.active_sql_conn
            const active_wke_id = state.active_wke_id
            const request_sent_time = new Date().valueOf()
            try {
                commit(`PATCH_${prvwMode}_MAP`, {
                    id: active_wke_id,
                    payload: {
                        request_sent_time,
                        total_duration: 0,
                        [`loading_${prvwMode.toLowerCase()}`]: true,
                    },
                })
                let sql
                const escapedTblId = this.vue.$help.escapeIdentifiers(tblId)
                let queryName
                switch (prvwMode) {
                    case rootState.app_config.SQL_QUERY_MODES.PRVW_DATA:
                        sql = `SELECT * FROM ${escapedTblId} LIMIT 1000;`
                        queryName = `Preview ${escapedTblId} data`
                        break
                    case rootState.app_config.SQL_QUERY_MODES.PRVW_DATA_DETAILS:
                        sql = `DESCRIBE ${escapedTblId};`
                        queryName = `View ${escapedTblId} details`
                        break
                }

                let res = await this.$queryHttp.post(`/sql/${active_sql_conn.id}/queries`, {
                    sql,
                    max_rows: rootState.persisted.query_max_rows,
                })
                const now = new Date().valueOf()
                const total_duration = ((now - request_sent_time) / 1000).toFixed(4)
                commit(`PATCH_${prvwMode}_MAP`, {
                    id: active_wke_id,
                    payload: {
                        data: Object.freeze(res.data.data),
                        total_duration: parseFloat(total_duration),
                        [`loading_${prvwMode.toLowerCase()}`]: false,
                    },
                })
                dispatch(
                    'persisted/pushQueryLog',
                    {
                        startTime: now,
                        name: queryName,
                        sql,
                        res,
                        connection_name: active_sql_conn.name,
                        queryType: rootState.app_config.QUERY_LOG_TYPES.ACTION_LOGS,
                    },
                    { root: true }
                )
            } catch (e) {
                commit(`PATCH_${prvwMode}_MAP`, {
                    id: active_wke_id,
                    payload: {
                        [`loading_${prvwMode.toLowerCase()}`]: false,
                    },
                })
                const logger = this.vue.$logger(`store-query-fetchPrvw`)
                logger.error(e)
            }
        },

        /**
         * @param {String} query - SQL query string
         */
        async fetchQueryResult({ state, commit, dispatch, rootState }, query) {
            const active_wke_id = state.active_wke_id
            const active_sql_conn = rootState.queryConn.active_sql_conn
            const request_sent_time = new Date().valueOf()

            try {
                commit('PATCH_QUERY_RESULTS_MAP', {
                    id: active_wke_id,
                    payload: {
                        request_sent_time,
                        total_duration: 0,
                        loading_query_result: true,
                    },
                })

                /**
                 * dispatch openBgConn before running the user's query to prevent concurrent
                 * querying of the same connection.
                 * This "BACKGROUND" connection must be disconnected after finnish the user's query.
                 * i.e. dispatch disconnectBgConn
                 */
                await dispatch('queryConn/openBgConn', active_sql_conn, { root: true })

                let res = await this.$queryHttp.post(`/sql/${active_sql_conn.id}/queries`, {
                    sql: query,
                    max_rows: rootState.persisted.query_max_rows,
                })
                const now = new Date().valueOf()
                const total_duration = ((now - request_sent_time) / 1000).toFixed(4)

                commit('PATCH_QUERY_RESULTS_MAP', {
                    id: active_wke_id,
                    payload: {
                        results: Object.freeze(res.data.data),
                        total_duration: parseFloat(total_duration),
                        loading_query_result: false,
                    },
                })

                const USE_REG = /(use|drop database)\s/i
                if (query.match(USE_REG)) await dispatch('updateActiveDb')
                dispatch(
                    'persisted/pushQueryLog',
                    {
                        startTime: now,
                        sql: query,
                        res,
                        connection_name: active_sql_conn.name,
                        queryType: rootState.app_config.QUERY_LOG_TYPES.USER_LOGS,
                    },
                    { root: true }
                )
            } catch (e) {
                commit('PATCH_QUERY_RESULTS_MAP', {
                    id: active_wke_id,
                    payload: { loading_query_result: false },
                })
                const logger = this.vue.$logger(`store-query-fetchQueryResult`)
                logger.error(e)
            }
        },
        async stopQuery({ state, commit, rootGetters, rootState }) {
            const active_sql_conn = rootState.queryConn.active_sql_conn
            const active_wke_id = state.active_wke_id
            try {
                commit('SET_IS_STOPPING_QUERY_MAP', { id: active_wke_id, payload: true })
                const {
                    data: { data: { attributes: { results = [] } = {} } = {} } = {},
                } = await this.$queryHttp.post(
                    `/sql/${rootGetters['queryConn/getBgConn'].id}/queries`,
                    {
                        sql: `KILL QUERY ${active_sql_conn.attributes.thread_id}`,
                    }
                )

                if (results.length && results[0].errno)
                    commit(
                        'SET_SNACK_BAR_MESSAGE',
                        {
                            text: [
                                'Failed to stop the query',
                                ...Object.keys(results[0]).map(key => `${key}: ${results[0][key]}`),
                            ],
                            type: 'error',
                        },
                        { root: true }
                    )
            } catch (e) {
                const logger = this.vue.$logger(`store-query-stopQuery`)
                logger.error(e)
            }
            commit('SET_IS_STOPPING_QUERY_MAP', { id: active_wke_id, payload: false })
        },
        /**
         * @param {String} db - database name
         */
        async useDb({ state, commit, dispatch, rootState }, db) {
            const active_sql_conn = rootState.queryConn.active_sql_conn
            const active_wke_id = state.active_wke_id
            try {
                const now = new Date().valueOf()
                const escapedDb = this.vue.$help.escapeIdentifiers(db)
                const sql = `USE ${escapedDb};`
                let res = await this.$queryHttp.post(`/sql/${active_sql_conn.id}/queries`, {
                    sql,
                })
                let queryName = `Change default database to ${escapedDb}`
                if (res.data.data.attributes.results[0].errno) {
                    const errObj = res.data.data.attributes.results[0]
                    commit(
                        'SET_SNACK_BAR_MESSAGE',
                        {
                            text: Object.keys(errObj).map(key => `${key}: ${errObj[key]}`),
                            type: 'error',
                        },
                        { root: true }
                    )
                    queryName = `Failed to change default database to ${escapedDb}`
                } else commit('SET_ACTIVE_DB', { payload: db, active_wke_id })
                dispatch(
                    'persisted/pushQueryLog',
                    {
                        startTime: now,
                        name: queryName,
                        sql,
                        res,
                        connection_name: active_sql_conn.name,
                        queryType: rootState.app_config.QUERY_LOG_TYPES.ACTION_LOGS,
                    },
                    { root: true }
                )
            } catch (e) {
                const logger = this.vue.$logger('store-query-useDb')
                logger.error(e)
            }
        },
        async updateActiveDb({ state, commit, rootState }) {
            const active_sql_conn = rootState.queryConn.active_sql_conn
            const active_db = state.active_db
            const active_wke_id = state.active_wke_id
            try {
                let res = await this.$queryHttp.post(`/sql/${active_sql_conn.id}/queries`, {
                    sql: 'SELECT DATABASE()',
                })
                const resActiveDb = this.vue
                    .$typy(res, 'data.data.attributes.results[0].data')
                    .safeArray.flat()[0]
                if (!resActiveDb) commit('SET_ACTIVE_DB', { payload: '', active_wke_id })
                else if (active_db !== resActiveDb)
                    commit('SET_ACTIVE_DB', { payload: resActiveDb, active_wke_id })
            } catch (e) {
                const logger = this.vue.$logger('store-query-updateActiveDb')
                logger.error(e)
            }
        },
        async queryCharsetCollationMap({ rootState, commit }) {
            const active_sql_conn = rootState.queryConn.active_sql_conn
            try {
                const sql =
                    // eslint-disable-next-line vue/max-len
                    'SELECT character_set_name, collation_name, is_default FROM information_schema.collations'
                let res = await this.$queryHttp.post(`/sql/${active_sql_conn.id}/queries`, {
                    sql,
                })
                let charsetCollationMap = new Map()
                const data = this.vue.$typy(res, 'data.data.attributes.results[0].data').safeArray
                data.forEach(row => {
                    const charset = row[0]
                    const collation = row[1]
                    const isDefCollation = row[2] === 'Yes'
                    let charsetObj = charsetCollationMap.get(charset) || {
                        collations: [],
                    }
                    if (isDefCollation) charsetObj.defCollation = collation
                    charsetObj.collations.push(collation)
                    charsetCollationMap.set(charset, charsetObj)
                })
                commit('SET_CHARSET_COLLATION_MAP', charsetCollationMap)
            } catch (e) {
                const logger = this.vue.$logger('store-query-queryCharsetCollationMap')
                logger.error(e)
            }
        },
        async queryDefDbCharsetMap({ rootState, commit }) {
            const active_sql_conn = rootState.queryConn.active_sql_conn
            try {
                const sql =
                    // eslint-disable-next-line vue/max-len
                    'SELECT schema_name, default_character_set_name FROM information_schema.schemata'
                let res = await this.$queryHttp.post(`/sql/${active_sql_conn.id}/queries`, {
                    sql,
                })
                let defDbCharsetMap = new Map()
                const data = this.vue.$typy(res, 'data.data.attributes.results[0].data').safeArray
                data.forEach(row => {
                    const schema_name = row[0]
                    const default_character_set_name = row[1]
                    defDbCharsetMap.set(schema_name, default_character_set_name)
                })
                commit('SET_DEF_DB_CHARSET_MAP', defDbCharsetMap)
            } catch (e) {
                const logger = this.vue.$logger('store-query-queryDefDbCharsetMap')
                logger.error(e)
            }
        },
        async queryEngines({ rootState, commit }) {
            const active_sql_conn = rootState.queryConn.active_sql_conn
            try {
                let res = await this.$queryHttp.post(`/sql/${active_sql_conn.id}/queries`, {
                    sql: 'SELECT engine FROM information_schema.ENGINES',
                })
                commit('SET_ENGINES', res.data.data.attributes.results[0].data.flat())
            } catch (e) {
                const logger = this.vue.$logger('store-query-queryEngines')
                logger.error(e)
            }
        },
        async queryTblCreationInfo({ state, commit, rootState }, node) {
            const active_sql_conn = rootState.queryConn.active_sql_conn
            const active_wke_id = state.active_wke_id
            try {
                commit('PATCH_TBL_CREATION_INFO_MAP', {
                    id: active_wke_id,
                    payload: {
                        loading_tbl_creation_info: true,
                        altered_active_node: node,
                    },
                })
                const schemas = node.id.split('.')
                const db = schemas[0]
                const tblOptsData = await queryHelper.queryTblOptsData({
                    active_sql_conn,
                    nodeId: node.id,
                    vue: this.vue,
                    $queryHttp: this.$queryHttp,
                })
                const colsOptsData = await queryHelper.queryColsOptsData({
                    active_sql_conn,
                    nodeId: node.id,
                    $queryHttp: this.$queryHttp,
                })
                commit(`PATCH_TBL_CREATION_INFO_MAP`, {
                    id: active_wke_id,
                    payload: {
                        data: {
                            table_opts_data: { dbName: db, ...tblOptsData },
                            cols_opts_data: colsOptsData,
                        },
                        loading_tbl_creation_info: false,
                    },
                })
            } catch (e) {
                commit('PATCH_TBL_CREATION_INFO_MAP', {
                    id: active_wke_id,
                    payload: {
                        loading_tbl_creation_info: false,
                    },
                })
                commit(
                    'SET_SNACK_BAR_MESSAGE',
                    {
                        text: this.vue.$help.getErrorsArr(e),
                        type: 'error',
                    },
                    { root: true }
                )
                const logger = this.vue.$logger(`store-query-queryTblCreationInfo`)
                logger.error(e)
            }
        },

        /**
         * This action is used to execute statement or statements.
         * Since users are allowed to modify the auto-generated SQL statement,
         * they can add more SQL statements after or before the auto-generated statement
         * which may receive error. As a result, the action log still log it as a failed action.
         * This can be fixed if a SQL parser is introduced.
         * @param {String} payload.sql - sql to be executed
         * @param {String} payload.action - action name. e.g. DROP TABLE table_name
         * @param {Boolean} payload.showSnackbar - show successfully snackbar message
         */
        async exeStmtAction(
            { state, rootState, dispatch, commit },
            { sql, action, showSnackbar = true }
        ) {
            const active_sql_conn = rootState.queryConn.active_sql_conn
            const active_wke_id = state.active_wke_id
            const request_sent_time = new Date().valueOf()
            try {
                let stmt_err_msg_obj = {}
                let res = await this.$queryHttp.post(`/sql/${active_sql_conn.id}/queries`, {
                    sql,
                    max_rows: rootState.persisted.query_max_rows,
                })
                const results = this.vue.$typy(res, 'data.data.attributes.results').safeArray
                const errMsgs = results.filter(res => this.vue.$typy(res, 'errno').isDefined)
                // if multi statement mode, it'll still return only an err msg obj
                if (errMsgs.length) stmt_err_msg_obj = errMsgs[0]
                commit('PATCH_EXE_STMT_RESULT_MAP', {
                    id: active_wke_id,
                    payload: {
                        data: res.data.data.attributes,
                        stmt_err_msg_obj,
                    },
                })
                let queryAction
                if (!this.vue.$typy(stmt_err_msg_obj).isEmptyObject)
                    queryAction = this.i18n.t('errors.failedToExeAction', { action })
                else {
                    queryAction = this.i18n.t('info.exeActionSuccessfully', { action })
                    if (showSnackbar)
                        commit(
                            'SET_SNACK_BAR_MESSAGE',
                            { text: [queryAction], type: 'success' },
                            { root: true }
                        )
                }
                dispatch(
                    'persisted/pushQueryLog',
                    {
                        startTime: request_sent_time,
                        name: queryAction,
                        sql,
                        res,
                        connection_name: active_sql_conn.name,
                        queryType: rootState.app_config.QUERY_LOG_TYPES.ACTION_LOGS,
                    },
                    { root: true }
                )
            } catch (e) {
                commit('PATCH_EXE_STMT_RESULT_MAP', {
                    id: active_wke_id,
                    payload: {
                        result: this.vue.$help.getErrorsArr(e),
                    },
                })
                const logger = this.vue.$logger(`store-query-exeStmtAction`)
                logger.error(e)
            }
        },

        changeWkeName({ state, getters, commit }, name) {
            let newWke = this.vue.$help.lodash.cloneDeep(getters.getActiveWke)
            newWke.name = name
            commit('UPDATE_WKE', {
                idx: state.worksheets_arr.indexOf(getters.getActiveWke),
                wke: newWke,
            })
        },
        releaseMemory({ commit }, wkeId) {
            const mutationTypesMap = getMemStateMutationTypes()
            Object.keys(mutationTypesMap).forEach(key => {
                commit(`${mutationTypesMap[key]}_${key.toUpperCase()}`, { id: wkeId })
            })
        },
        /**
         * This action clears prvw_data and prvw_data_details to empty object.
         * Call this action when user selects option in the sidebar.
         * This ensure sub-tabs in Data Preview tab are generated with fresh data
         */
        clearDataPreview({ state, commit }) {
            commit(`PATCH_PRVW_DATA_MAP`, {
                id: state.active_wke_id,
                payload: {
                    loading_prvw_data: false,
                    data: {},
                    request_sent_time: 0,
                    total_duration: 0,
                },
            })
            commit(`PATCH_PRVW_DATA_DETAILS_MAP`, {
                id: state.active_wke_id,
                payload: {
                    loading_prvw_data_details: false,
                    data: {},
                    request_sent_time: 0,
                    total_duration: 0,
                },
            })
        },
    },
    getters: {
        getActiveWke: state => {
            return state.worksheets_arr.find(wke => wke.id === state.active_wke_id)
        },
        getIsQuerying: state => {
            return state.is_querying_map[state.active_wke_id] || false
        },
        getQueryErrMsgObj: state => {
            return state.lost_cnn_err_msg_obj_map[state.active_wke_id] || {}
        },
        // sidebar getters
        getCurrDbTree: state => state.db_tree_map[state.active_wke_id] || {},
        getActiveTreeNode: (state, getters) => {
            return getters.getCurrDbTree.active_tree_node || {}
        },
        getDbTreeData: (state, getters) => {
            return getters.getCurrDbTree.data || []
        },
        getDbNodes: (state, getters) => {
            return getters.getDbTreeData.map(node => ({ name: node.name, id: node.id }))
        },
        getLoadingDbTree: (state, getters) => getters.getCurrDbTree.loading_db_tree || false,
        getDbCmplList: (state, getters) => {
            if (getters.getCurrDbTree.db_completion_list)
                return uniqBy(getters.getCurrDbTree.db_completion_list, 'label')
            return []
        },
        // Query result getters
        getQueryResult: state => state.query_results_map[state.active_wke_id] || {},
        getLoadingQueryResult: (state, getters) => {
            const { loading_query_result = false } = getters.getQueryResult
            return loading_query_result
        },
        getIsStoppingQuery: state => state.is_stopping_query_map[state.active_wke_id] || false,
        getResults: (state, getters) => {
            const { results = {} } = getters.getQueryResult
            return results
        },
        getQueryRequestSentTime: (state, getters) => {
            const { request_sent_time = 0 } = getters.getQueryResult
            return request_sent_time
        },
        getQueryExeTime: (state, getters) => {
            if (getters.getLoadingQueryResult) return -1
            const { attributes } = getters.getResults
            if (attributes) return parseFloat(attributes.execution_time.toFixed(4))
            return 0
        },
        getQueryTotalDuration: (state, getters) => {
            const { total_duration = 0 } = getters.getQueryResult
            return total_duration
        },
        // preview data getters
        getPrvwData: state => mode => {
            let map = state[`${mode.toLowerCase()}_map`]
            if (map) return map[state.active_wke_id] || {}
            return {}
        },
        getLoadingPrvw: (state, getters) => mode => {
            return getters.getPrvwData(mode)[`loading_${mode.toLowerCase()}`] || false
        },
        getPrvwDataRes: (state, getters) => mode => {
            const { data: { attributes: { results = [] } = {} } = {} } = getters.getPrvwData(mode)
            if (results.length) return results[0]
            return {}
        },
        getPrvwExeTime: (state, getters) => mode => {
            if (state[`loading_${mode.toLowerCase()}`]) return -1
            const { data: { attributes } = {} } = getters.getPrvwData(mode)
            if (attributes) return parseFloat(attributes.execution_time.toFixed(4))
            return 0
        },
        getPrvwSentTime: (state, getters) => mode => {
            const { request_sent_time = 0 } = getters.getPrvwData(mode)
            return request_sent_time
        },
        getPrvwTotalDuration: (state, getters) => mode => {
            const { total_duration = 0 } = getters.getPrvwData(mode)
            return total_duration
        },
        //editor mode getter
        getCurrEditorMode: state => state.curr_editor_mode_map[state.active_wke_id] || 'TXT_EDITOR',
        // tbl_creation_info_map getters
        getTblCreationInfo: state => state.tbl_creation_info_map[state.active_wke_id] || {},
        getLoadingTblCreationInfo: (state, getters) => {
            const { loading_tbl_creation_info = true } = getters.getTblCreationInfo
            return loading_tbl_creation_info
        },
        getAlteredActiveNode: (state, getters) => {
            const { altered_active_node = {} } = getters.getTblCreationInfo
            return altered_active_node
        },
        // exe_stmt_result_map getters
        getExeStmtResultMap: state => state.exe_stmt_result_map[state.active_wke_id] || {},
    },
}
