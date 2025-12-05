import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/dist/locale/zh-cn.mjs'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import App from './App.vue'
import router from './router'
import { useUserStore } from './stores/user'
import './assets/styles/main.css'
import './assets/styles/global.css'

// Chrome 在固定背景 + 多层 backdrop-blur 下易触发 GPU 合成崩溃，运行时为 Chrome 关闭模糊
const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
const isChromeDesktop =
  /Chrome/i.test(ua) && !/Edg|OPR|Brave|CriOS|FxiOS|SamsungBrowser|UCBrowser/i.test(ua)

if (isChromeDesktop && typeof document !== 'undefined') {
  document.documentElement.classList.add('chrome-no-blur')
}

// 创建Vue应用
const app = createApp(App)

// 使用Pinia状态管理
const pinia = createPinia()
app.use(pinia)

// 使用路由
app.use(router)

// 使用Element Plus
app.use(ElementPlus, {
  locale: zhCn
})

// 设置axios拦截器
const userStore = useUserStore()
userStore.setupAxiosInterceptors()

// 挂载应用
app.mount('#app')
