<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { ensureDeviceToken, fetchSessions } from '../api/chatApi'
import AppHeader from '../components/AppHeader.vue'
import SidebarNav from '../components/SidebarNav.vue'
import { replaceSessions } from '../store/sessionStore'

/**
 * MainLayout 负责渲染全局两栏结构，左侧为边栏，右侧为页面内容。
 * 通过状态控制边栏是否收起，便于不同页面复用同一布局。
 */
const isSidebarCollapsed = ref(false)
const mobileSidebarOpen = ref(false)
const route = useRoute()
const activeSessionId = computed(() => String(route.params.sessionID || ''))

// 大屏宽度变化（跨越 900px 阈值）时，自动关闭移动端遮罩
function onWindowResize() {
  if (window.innerWidth > 900 && mobileSidebarOpen.value) {
    mobileSidebarOpen.value = false
  }
}

onMounted(async () => {
  window.addEventListener('resize', onWindowResize)
  try {
    await ensureDeviceToken()
    const sessions = await fetchSessions()
    replaceSessions(sessions)
  } catch (error) {
    console.warn('初始化会话列表失败:', error)
  }
})

// 侧边栏 session 跳转时，移动端自动关闭遮罩
watch(() => route.fullPath, () => {
  if (mobileSidebarOpen.value) mobileSidebarOpen.value = false
})
</script>

<template>
  <div
    class="deepseek-app"
    :class="{ 'sidebar-collapsed': isSidebarCollapsed, 'mobile-sidebar-open': mobileSidebarOpen }"
    :style="{ '--sidebar-width': isSidebarCollapsed ? '92px' : '240px' }"
  >
    <SidebarNav
      :active-session-id="activeSessionId"
      :collapsed="isSidebarCollapsed"
      @toggle-collapse="isSidebarCollapsed = !isSidebarCollapsed"
    />

    <!-- 移动端遮罩：点击遮罩关闭 drawer -->
    <div v-if="mobileSidebarOpen" class="mobile-drawer-mask" @click="mobileSidebarOpen = false"></div>

    <div class="content-shell">
      <div class="header-shell">
        <AppHeader @open-mobile-sidebar="mobileSidebarOpen = true" />
      </div>
      <div class="route-shell">
        <router-view />
      </div>
    </div>
  </div>
</template>

<style scoped>
.deepseek-app {
  --sidebar-width: 240px;
  position: relative;
  display: block;
  min-height: 100vh;
  background: #f3f5f7;
  transition: padding-left 0.28s ease;
}

.deepseek-app.sidebar-collapsed {
  --sidebar-width: 92px;
}

.content-shell {
  display: flex;
  flex-direction: column;
  margin-left: var(--sidebar-width);
  min-width: 0;
  width: auto;
  height: 100vh;
  overflow: hidden;
}

.header-shell {
  position: fixed;
  top: 0;
  left: var(--sidebar-width);
  right: 0;
  z-index: 20;
}

.route-shell {
  padding-top: 48px;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

/* ---------- 移动端 drawer ---------- */
.mobile-drawer-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.42);
  z-index: 55;
  backdrop-filter: blur(1px);
  animation: maskFadeIn 0.22s ease-out;
}
@keyframes maskFadeIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}

@media (max-width: 900px) {
  .content-shell {
    margin-left: 0;
  }

  .header-shell {
    left: 0;
  }

  /* 小屏默认 sidebar 通过 display:none 隐藏；drawer 开启时强制显示并从左侧滑入 */
  :deep(.sidebar) {
    display: flex;
    transform: translateX(-100%);
    box-shadow: none;
  }

  .deepseek-app.mobile-sidebar-open :deep(.sidebar) {
    transform: translateX(0);
    box-shadow: 8px 0 28px rgba(15, 23, 42, 0.18);
  }
}
</style>
