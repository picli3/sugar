import { createApp } from 'vue'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import './style.css'
// An embedded document never mounts the authenticated editor, even for signed-in visitors.
const view = window.location.pathname.startsWith('/embed/') ? import('./EmbedViewer.vue') : import('./App.vue')
view.then(({ default: component }) => createApp(component).mount('#app'))
