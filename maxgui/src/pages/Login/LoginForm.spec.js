import chai, { expect } from 'chai'
import mount from '@tests/unit/setup'
import LoginForm from '@/pages/Login/LoginForm'
import { mockupInputChange, mockupRouteChanges } from '@tests/unit/mockup'
import moxios from 'moxios'
import sinon from 'sinon'
import sinonChai from 'sinon-chai'
chai.should()
chai.use(sinonChai)

/**
 * This function mockup checking remember me box
 * @param {Object} wrapper A Wrapper is an object that contains a mounted component and methods to test the component
 */
async function mockupCheckingTheBox(wrapper) {
    const vCheckBox = wrapper.findComponent({ name: 'v-checkbox' })
    const input = vCheckBox.find('input')
    await input.trigger('click')
}
describe('LoginForm.vue', () => {
    let wrapper
    let stub
    beforeEach(() => {
        wrapper = mount({
            shallow: false,
            component: LoginForm,
        })
        moxios.install(wrapper.vm.loginAxios)
        stub = sinon.stub(wrapper.vm.loginAxios, 'get')
    })

    afterEach(async () => {
        moxios.uninstall(wrapper.vm.loginAxios)
        stub.restore()
        await mockupRouteChanges(wrapper, '/login')
    })

    it('Should render username and password fields.', () => {
        const emailInput = wrapper.find('#username')
        const passwordInput = wrapper.find('#password')

        expect(emailInput.exists()).to.be.true
        expect(passwordInput.exists()).to.be.true
    })

    it('Should render login button.', () => {
        const addButton = wrapper.find('.login-btn')
        expect(addButton.exists()).to.be.true
    })

    it('Should disable login button if username or password is empty', () => {
        const addButton = wrapper.find('.login-btn')
        expect(addButton.attributes().disabled).to.be.equals('disabled')
    })

    it('Should not disable login button if form is valid', async () => {
        await mockupInputChange(wrapper, 'admin', '#username')
        await mockupInputChange(wrapper, 'mariadb', '#password')

        const addButton = wrapper.find('.login-btn')
        expect(addButton.attributes().disabled).to.be.not.equals('disabled')
    })

    it('Should call handleSubmit if "Sign in" button is clicked', async () => {
        const spy = sinon.spy(wrapper.vm, 'handleSubmit')
        await mockupInputChange(wrapper, 'admin', '#username')
        await mockupInputChange(wrapper, 'mariadb', '#password')

        await wrapper.find('.login-btn').trigger('click')
        spy.should.have.been.calledOnce
    })

    it(`Should allows to toggle masked password`, async () => {
        await mockupInputChange(wrapper, 'mariadb', '#password')

        expect(wrapper.vm.$data.isPwdVisible).to.be.equal(false)
        const passwordInput = wrapper.find('#password')
        let inputs = passwordInput.findAll('input')
        let toggleMaskPwdBtn = wrapper.findAll('.v-input__append-inner > button')
        expect(inputs.length).to.be.equal(1)
        expect(toggleMaskPwdBtn.length).to.be.equal(1)

        let input = inputs.at(0)
        expect(input.find('[type = "password"]').exists()).to.be.equal(true)

        await toggleMaskPwdBtn.at(0).trigger('click')
        expect(wrapper.vm.$data.isPwdVisible).to.be.equal(true)
        expect(input.find('[type = "text"]').exists()).to.be.equal(true)
    })

    it('Should toggle the value of rememberMe', async () => {
        await mockupCheckingTheBox(wrapper) // checked
        expect(wrapper.vm.$data.rememberMe).to.be.true
        await mockupCheckingTheBox(wrapper) // unchecked
        expect(wrapper.vm.$data.rememberMe).to.be.false
    })

    it('Should send auth request when remember me is not chosen', async () => {
        await mockupInputChange(wrapper, 'admin', '#username')
        await mockupInputChange(wrapper, 'mariadb', '#password')
        await wrapper.find('.login-btn').trigger('click') //submit

        stub.should.have.been.calledWith('/auth?persist=yes', {
            auth: { username: 'admin', password: 'mariadb' },
        })
    })

    it('Should send auth request when remember me is chosen', async () => {
        await mockupCheckingTheBox(wrapper) // checked
        await mockupInputChange(wrapper, 'maxskysql', '#username')
        await mockupInputChange(wrapper, 'skysql', '#password')
        await wrapper.find('.login-btn').trigger('click') //submit

        stub.should.have.been.calledWith('/auth?persist=yes&max-age=28800', {
            auth: { username: 'maxskysql', password: 'skysql' },
        })
    })

    it('Should navigate to dashboard page once authenticating process is succeed', async () => {
        await mockupInputChange(wrapper, 'maxskysql', '#username')
        await mockupInputChange(wrapper, 'skysql', '#password')
        await wrapper.find('.login-btn').trigger('click') //submit
        stub.should.have.been.calledWith('/auth?persist=yes', {
            auth: { username: 'maxskysql', password: 'skysql' },
        })
        await wrapper.vm.$nextTick(() =>
            expect(wrapper.vm.$route.path).to.be.equals('/dashboard/servers')
        )
    })
})
