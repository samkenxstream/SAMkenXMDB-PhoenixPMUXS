/*
 * Copyright (c) 2020 MariaDB Corporation Ab
 *
 * Use of this software is governed by the Business Source License included
 * in the LICENSE.TXT file and at www.mariadb.com/bsl11.
 *
 * Change Date: 2025-11-19
 *
 * On the date above, in accordance with the Business Source License, use
 * of this software will be governed by version 2 or later of the General
 * Public License.
 */
import store from 'store'
import chai, { expect } from 'chai'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'
import mount from '@tests/unit/setup'
import LogContainer from '@/pages/Logs/LogContainer'
import { dummy_log_data } from '@tests/unit/utils'

chai.should()
chai.use(sinonChai)

const dummyChosenLogLevels = ['warning']
const dummyFilteredLog = dummy_log_data.filter(log => dummyChosenLogLevels.includes(log.priority))

const mountFactory = () =>
    mount({
        shallow: false,
        component: LogContainer,
        props: {
            logViewHeight: 500,
            chosenLogLevels: [],
        },
        computed: {
            prev_log_link: () => null, // prevent loopGetOlderLogs from being called
        },
    })

// mockup websocket
class WebSocket {
    constructor() {}
    onmessage() {}
    close() {}
    onopen() {}
}

global.WebSocket = WebSocket

describe('Logs index', () => {
    let wrapper, axiosStub, wsStub
    beforeEach(async () => {
        wsStub = sinon.stub(window, 'WebSocket')
        axiosStub = sinon.stub(store.$http, 'get').returns(
            Promise.resolve({
                data: {
                    data: {
                        attributes: { log: dummy_log_data, log_source: 'syslog' },
                    },
                },
            })
        )
        wrapper = mountFactory()
        /* async setTimeout doesn't work properly in vue-test-utils as
         * there is no actual async lifecycle hooks in vue.js. So
         * allLogData will be always an empty array.
         * This is a workaround to delay 350ms after mounted hook is called,
         * so allLogData will be assigned with dummy_log_data
         */
        await wrapper.vm.$help.delay(350)
    })
    afterEach(async function() {
        await axiosStub.restore()
        await wsStub.restore()
        await wrapper.destroy()
    })

    it(`Should send requests to get maxscale log when shouldFetchLogs is true`, async () => {
        await wrapper.setProps({
            shouldFetchLogs: true,
        })
        await axiosStub.should.have.been.calledWith('/maxscale/logs/data?page[size]=1000')
        axiosStub.should.have.been.called
    })

    it(`Should pass necessary props to log-lines component`, async () => {
        const logLines = wrapper.findComponent({ name: 'log-lines' })
        expect(logLines.vm.$props.allLogData).to.be.deep.equals(wrapper.vm.$data.allLogData)
        expect(logLines.vm.$props.filteredLog).to.be.deep.equals(wrapper.vm.$data.filteredLog)
        expect(logLines.vm.$props.isFiltering).to.be.equals(wrapper.vm.isFiltering)
        expect(logLines.vm.$props.isLoading).to.be.deep.equals(wrapper.vm.$data.isLoading)
    })

    it(`Should return accurate boolean value for computed property 'isFiltering'`, async () => {
        expect(wrapper.vm.isFiltering).to.be.false
        await wrapper.setData({
            chosenLogLevels: dummyChosenLogLevels,
            filteredLog: dummyFilteredLog,
        })
        expect(wrapper.vm.isFiltering).to.be.true
    })
})