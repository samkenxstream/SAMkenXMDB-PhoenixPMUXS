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
import { pickBy } from 'utils/helpers'
import queryHelper from './queryHelper'
import { sidebarStates, resultStates, toolbarStates } from './query'
/**
 * @returns Initial connection related states
 */
export function connStatesToBeSynced() {
    return {
        active_sql_conn: {},
        conn_err_state: false,
    }
}

/**
 * This function resets all properties of the provided targetWke object to its initial states
 * except states that stores editor data (editorStates)
 * @param {Object} targetWke - wke to be emptied
 * @returns {Object} - a worksheet object
 */
function getBlankWke(targetWke) {
    return {
        ...targetWke,
        ...connStatesToBeSynced(),
        ...sidebarStates(),
        ...resultStates(),
        ...toolbarStates(),
        name: 'WORKSHEET',
    }
}
/**
 * Below states are stored in hash map structure.
 * Using worksheet's id as key. This helps to preserve
 * multiple worksheet's data in memory.
 * Use `queryHelper.memStatesMutationCreator` to create corresponding mutations
 * Some keys will have mutation name starts with either `SET` or `PATCH`
 * prefix. Check connMemStateMutationTypeMap for more info
 * @returns {Object} - returns states that are stored in memory
 */
function memStates() {
    return {
        is_querying_map: {},
        lost_cnn_err_msg_obj_map: {},
    }
}
export function connMemStateMutationTypeMap() {
    return Object.keys(memStates()).reduce((res, key) => ({ ...res, [key]: 'SET' }), {})
}
export default {
    namespaced: true,
    state: {
        sql_conns: {}, // persisted
        is_validating_conn: true,
        rc_target_names_map: {},
        pre_select_conn_rsrc: null,
        /**
         * states to be synced to worksheets_arr.
         * Mutations are created by queryHelper.syncedStateMutationsCreator(connStatesToBeSynced())
         */
        ...connStatesToBeSynced(),
        ...memStates(),
    },
    mutations: {
        SET_IS_VALIDATING_CONN(state, payload) {
            state.is_validating_conn = payload
        },
        SET_SQL_CONNS(state, payload) {
            state.sql_conns = payload
        },
        ADD_SQL_CONN(state, payload) {
            this.vue.$set(state.sql_conns, payload.id, payload)
        },
        DELETE_SQL_CONN(state, payload) {
            this.vue.$delete(state.sql_conns, payload.id)
        },
        SET_RC_TARGET_NAMES_MAP(state, payload) {
            state.rc_target_names_map = payload
        },
        SET_PRE_SELECT_CONN_RSRC(state, payload) {
            state.pre_select_conn_rsrc = payload
        },
        ...queryHelper.syncedStateMutationsCreator(connStatesToBeSynced()),
        ...queryHelper.memStatesMutationCreator({
            mutationTypesMap: connMemStateMutationTypeMap(),
        }),
        /**
         * When active_wke_id is changed, call this to sync properties from worksheets_arr
         * back to connStatesToBeSynced in this module
         * @param {Object} state - vuex state
         * @param {Object} wke - wke object
         */
        SYNC_CONN_STATES(state, wke) {
            queryHelper.mutateFlatStates({
                moduleState: state,
                data: pickBy(wke, (v, key) => Object.keys(connStatesToBeSynced()).includes(key)),
            })
        },
    },
    actions: {
        async fetchRcTargetNames({ state, commit }, resourceType) {
            try {
                const res = await this.$queryHttp.get(`/${resourceType}?fields[${resourceType}]=id`)
                if (res.data.data) {
                    const names = res.data.data.map(({ id, type }) => ({ id, type }))
                    commit('SET_RC_TARGET_NAMES_MAP', {
                        ...state.rc_target_names_map,
                        [resourceType]: names,
                    })
                }
            } catch (e) {
                this.vue.$logger('store-query-fetchRcTargetNames').error(e)
            }
        },
        /**
         * @param {Boolean} param.silentValidation - silent validation (without calling SET_IS_VALIDATING_CONN)
         */
        async validatingConn(
            { state, commit, dispatch, rootState },
            { silentValidation = false } = {}
        ) {
            if (!silentValidation) commit('SET_IS_VALIDATING_CONN', true)
            try {
                const active_wke_id = rootState.query.active_wke_id
                const res = await this.$queryHttp.get(`/sql/`)
                const resConnMap = this.vue.$help.lodash.keyBy(res.data.data, 'id')
                const resConnIds = Object.keys(resConnMap)
                const clientConnIds = queryHelper.getClientConnIds()
                if (resConnIds.length === 0) {
                    dispatch('resetAllWkeStates')
                    commit('SET_SQL_CONNS', {})
                } else {
                    const validConnIds = clientConnIds.filter(id => resConnIds.includes(id))
                    const validSqlConns = Object.keys(state.sql_conns)
                        .filter(id => validConnIds.includes(id))
                        .reduce(
                            (acc, id) => ({
                                ...acc,
                                [id]: {
                                    ...state.sql_conns[id],
                                    attributes: resConnMap[id].attributes, // update attributes
                                },
                            }),
                            {}
                        )
                    const invalidCnctIds = Object.keys(state.sql_conns).filter(
                        id => !(id in validSqlConns)
                    )
                    //deleteInvalidConn
                    invalidCnctIds.forEach(id => {
                        this.vue.$help.deleteCookie(`conn_id_body_${id}`)
                        dispatch('resetWkeStates', id)
                    })

                    commit('SET_SQL_CONNS', validSqlConns)
                    // update active_sql_conn attributes
                    if (state.active_sql_conn.id) {
                        const active_sql_conn = validSqlConns[state.active_sql_conn.id]
                        commit('SET_ACTIVE_SQL_CONN', { payload: active_sql_conn, active_wke_id })
                    }
                }
            } catch (e) {
                this.vue.$logger('store-query-validatingConn').error(e)
            }
            if (!silentValidation) commit('SET_IS_VALIDATING_CONN', false)
        },
        async openConnect({ dispatch, commit, rootState }, { body, resourceType }) {
            const active_wke_id = rootState.query.active_wke_id
            try {
                const res = await this.$queryHttp.post(`/sql?persist=yes&max-age=86400`, body)
                if (res.status === 201) {
                    commit(
                        'SET_SNACK_BAR_MESSAGE',
                        {
                            text: [this.i18n.t('info.connSuccessfully')],
                            type: 'success',
                        },
                        { root: true }
                    )
                    const connId = res.data.data.id
                    const active_sql_conn = {
                        id: connId,
                        attributes: res.data.data.attributes,
                        name: body.target,
                        type: resourceType,
                        binding_type: rootState.app_config.QUERY_CONN_BINDING_TYPES.WORKSHEET,
                    }
                    commit('ADD_SQL_CONN', active_sql_conn)
                    commit('SET_ACTIVE_SQL_CONN', { payload: active_sql_conn, active_wke_id })

                    if (body.db) await dispatch('query/useDb', body.db, { root: true })
                    commit('SET_CONN_ERR_STATE', { payload: false, active_wke_id })
                }
            } catch (e) {
                this.vue.$logger('store-query-openConnect').error(e)
                commit('SET_CONN_ERR_STATE', { payload: true, active_wke_id })
            }
        },
        /**
         *  Clone a connection to allow it run in the background
         * @param {Object} conn_to_be_cloned - connection to be cloned
         */
        async openBgConn({ commit, rootState }, conn_to_be_cloned) {
            try {
                const res = await this.$queryHttp.post(
                    `/sql/${conn_to_be_cloned.id}/clone?persist=yes&max-age=86400`
                )
                if (res.status === 201) {
                    const connId = res.data.data.id
                    const conn = {
                        id: connId,
                        attributes: res.data.data.attributes,
                        name: conn_to_be_cloned.name,
                        type: conn_to_be_cloned.type,
                        binding_type: rootState.app_config.QUERY_CONN_BINDING_TYPES.BACKGROUND,
                    }
                    commit('ADD_SQL_CONN', conn)
                }
            } catch (e) {
                this.vue.$logger('store-query-openBgConn').error(e)
            }
        },
        async disconnect({ state, commit, dispatch }, { showSnackbar, id: cnctId }) {
            try {
                const res = await this.$queryHttp.delete(`/sql/${cnctId}`)
                if (res.status === 204) {
                    if (showSnackbar)
                        commit(
                            'SET_SNACK_BAR_MESSAGE',
                            {
                                text: [this.i18n.t('info.disconnSuccessfully')],
                                type: 'success',
                            },
                            { root: true }
                        )
                    commit('DELETE_SQL_CONN', state.sql_conns[cnctId])
                    dispatch('resetWkeStates', cnctId)
                }
            } catch (e) {
                this.vue.$logger('store-query-disconnect').error(e)
            }
        },
        /**
         * Disconnect the "BACKGROUND" connection of the current active_sql_conn
         * @param {Object} active_sql_conn - active_sql_conn
         */
        async disconnectBgConn({ dispatch, rootState, state }, active_sql_conn) {
            try {
                // find BACKGROUND connections of the current active sql connection
                const bgCnns = Object.values(state.sql_conns).filter(
                    cnn =>
                        cnn.name === active_sql_conn.name &&
                        cnn.binding_type ===
                            rootState.app_config.QUERY_CONN_BINDING_TYPES.BACKGROUND
                )
                for (const conn of bgCnns) await dispatch('disconnect', { id: conn.id })
            } catch (e) {
                this.vue.$logger('store-query-deleteBgConn').error(e)
            }
        },
        async disconnectAll({ state, dispatch }) {
            try {
                for (const id of Object.keys(state.sql_conns))
                    await dispatch('disconnect', { showSnackbar: false, id })
            } catch (e) {
                this.vue.$logger('store-query-disconnectAll').error(e)
            }
        },
        async reconnect({ state, commit, dispatch }) {
            const active_sql_conn = state.active_sql_conn
            try {
                const res = await this.$queryHttp.post(`/sql/${active_sql_conn.id}/reconnect`)
                if (res.status === 204) {
                    commit(
                        'SET_SNACK_BAR_MESSAGE',
                        {
                            text: [this.i18n.t('info.reconnSuccessfully')],
                            type: 'success',
                        },
                        { root: true }
                    )
                    await dispatch('query/initialFetch', active_sql_conn, { root: true })
                } else
                    commit(
                        'SET_SNACK_BAR_MESSAGE',
                        {
                            text: [this.i18n.t('errors.reconnFailed')],
                            type: 'error',
                        },
                        { root: true }
                    )
                await dispatch('validatingConn', { silentValidation: true })
            } catch (e) {
                this.vue.$logger('store-query-reconnect').error(e)
            }
        },
        clearConn({ commit, dispatch, state }) {
            try {
                const active_sql_conn = state.active_sql_conn
                commit('DELETE_SQL_CONN', active_sql_conn)
                dispatch('resetWkeStates', active_sql_conn.id)
            } catch (e) {
                this.vue.$logger('store-query-clearConn').error(e)
            }
        },
        /**
         * Call this action when disconnect a connection to
         * clear the state of the worksheet having that connection to its initial state
         */
        resetWkeStates({ state, commit, rootState, dispatch }, cnctId) {
            const targetWke = rootState.query.worksheets_arr.find(
                wke => wke.active_sql_conn.id === cnctId
            )
            if (targetWke) {
                dispatch('query/releaseQueryModulesMem', targetWke.id, { root: true })
                const idx = rootState.query.worksheets_arr.indexOf(targetWke)
                const wke = getBlankWke(targetWke)
                commit('query/UPDATE_WKE', { idx, wke }, { root: true })
                /**
                 * if connection id to be deleted is equal to current connected
                 * resource of active worksheet, sync wke states to flat states
                 */
                if (state.queryConn.active_sql_conn.id === cnctId) {
                    commit('query/SYNC_WKE_STATES', wke, { root: true })
                    commit('SYNC_CONN_STATES', wke)
                }
            }
        },
        // Reset all when there is no active connections
        resetAllWkeStates({ rootState, commit }) {
            for (const [idx, targetWke] of rootState.query.worksheets_arr.entries()) {
                const wke = getBlankWke(targetWke)
                commit('query/UPDATE_WKE', { idx, wke }, { root: true })
            }
        },
    },
    getters: {
        getBgConn: (state, getters, rootState) => {
            const bgConns = Object.values(state.sql_conns).filter(
                conn =>
                    conn.name === state.active_sql_conn.name &&
                    conn.binding_type === rootState.app_config.QUERY_CONN_BINDING_TYPES.BACKGROUND
            )
            if (bgConns.length) return bgConns[0]
            return {}
        },
        getIsQuerying: (state, getters, rootState) => {
            return state.is_querying_map[rootState.query.active_wke_id] || false
        },
        getLostCnnErrMsgObj: (state, getters, rootState) => {
            return state.lost_cnn_err_msg_obj_map[rootState.query.active_wke_id] || {}
        },
    },
}