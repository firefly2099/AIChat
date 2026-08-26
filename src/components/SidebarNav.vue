<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { CirclePlus, Close } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { Session } from '../store/sessionStore'
import {
  batchDeleteSessions,
  batchPinSessions,
  deleteSession,
  pinSession,
  updateSessionTitle,
} from '../api/chatApi'
import { useSessionStore } from '../store/sessionStore'

/**
 * 侧边栏导航属性。
 */
const props = defineProps<{
  activeSessionId?: string
  collapsed?: boolean
  onNavigateHome?: () => void
}>()

/**
 * 侧边栏展开/收起 / 移动端抽屉打开 事件。
 */
const emit = defineEmits<{
  (e: 'toggleCollapse'): void
  (e: 'mobileCloseSidebar'): void
}>()

const router = useRouter()
const sessionStore = useSessionStore()

/* -------------------------------------------------------------------------- */
/*  Store 封装：Session 类型加 pinned 字段兼容旧数据                           */
/* -------------------------------------------------------------------------- */
type SessionWithPinned = Session & { pinned?: boolean }
const allSessions = computed<SessionWithPinned[]>(() => sessionStore.sessionList as SessionWithPinned[])

/* -------------------------------------------------------------------------- */
/*  1. 分组：置顶 / 今天 / 7天内 / 30天内 / 按月归档                            */
/* -------------------------------------------------------------------------- */
type GroupKey =
  | 'pinned'
  | 'today'
  | 'last7d'
  | 'last30d'
  | string // YYYY-MM
const GROUP_LABEL: Record<string, string> = {
  pinned: '置顶',
  today: '今天',
  last7d: '7天内',
  last30d: '30天内',
}

function formatMonth(d: Date) {
  const y = d.getFullYear()
  const m = `${d.getMonth() + 1}`.padStart(2, '0')
  return `${y}-${m}`
}

function dateKeyOf(updatedAt: string | undefined): GroupKey {
  const now = new Date()
  const y0 = now.getFullYear()
  const m0 = now.getMonth()
  const d0 = now.getDate()
  const todayStart = new Date(y0, m0, d0, 0, 0, 0, 0).getTime()
  const sevenAgo = todayStart - 7 * 86400_000
  const thirtyAgo = todayStart - 30 * 86400_000

  const t = updatedAt ? new Date(updatedAt).getTime() : 0
  if (!t) return formatMonth(now)
  if (t >= todayStart) return 'today'
  if (t >= sevenAgo) return 'last7d'
  if (t >= thirtyAgo) return 'last30d'
  return formatMonth(new Date(t))
}

type GroupSection = { key: GroupKey; label: string; items: SessionWithPinned[] }

const groupedSections = computed<GroupSection[]>(() => {
  const pinned: SessionWithPinned[] = []
  const bucket: Record<GroupKey, SessionWithPinned[]> = {}
  for (const session of allSessions.value) {
    if (session.pinned) {
      pinned.push(session)
      continue
    }
    const key = dateKeyOf(session.updatedAt)
    ;(bucket[key] ||= []).push(session)
  }
  const sections: GroupSection[] = []
  if (pinned.length) sections.push({ key: 'pinned', label: GROUP_LABEL.pinned, items: pinned })

  // 时间分组按序：今天 > 7天 > 30天 > 2026-08 > 2026-07 ...
  const timeKeys = ['today', 'last7d', 'last30d'] as const
  for (const k of timeKeys) {
    if (bucket[k]?.length) sections.push({ key: k, label: GROUP_LABEL[k], items: bucket[k] })
  }
  const monthKeys = Object.keys(bucket).filter((k) => !timeKeys.includes(k as any))
  // 月份新的在前（字符串字典序对 YYYY-MM 直接有效）
  monthKeys.sort((a, b) => (a < b ? 1 : -1))
  for (const k of monthKeys) {
    if (bucket[k]?.length) sections.push({ key: k, label: k, items: bucket[k] })
  }
  return sections
})

/* -------------------------------------------------------------------------- */
/*  2. 对话项 hover → 三点按钮 → 弹出菜单（重命名/置顶/多选/删除）+ clickOutside */
/* -------------------------------------------------------------------------- */
const hoveredItemId = ref<string>('')
const openedMenuId = ref<string>('')
const menuTriggerRect = ref<{ top: number; left: number; width: number; height: number } | null>(null)

const editingSessionId = ref('')
const editingTitle = ref('')
const isSavingTitle = ref(false)
const editingInputRef = ref<HTMLInputElement | null>(null)

/** 多选模式：进入该模式后，每个 item 前面显示勾选框，顶栏显示“已选N个”，底栏显示批量操作按钮。 */
const isMultiSelectMode = ref(false)
const selectedIds = ref<Record<string, boolean>>({})
const selectedCount = computed(() => Object.values(selectedIds.value).filter(Boolean).length)

const isBulkProcessing = ref(false)
const isPinningSession = ref(false)
const isDeletingSession = ref(false)

const sidebarRef = ref<HTMLElement | null>(null)

function closeMenu() {
  openedMenuId.value = ''
  menuTriggerRect.value = null
}

function onMoreBtnClick(event: MouseEvent, sessionId: string) {
  event.stopPropagation()
  if (openedMenuId.value === sessionId) {
    closeMenu()
    return
  }
  const target = event.currentTarget as HTMLElement | null
  if (target) {
    const r = target.getBoundingClientRect()
    menuTriggerRect.value = { top: r.top, left: r.left, width: r.width, height: r.height }
  }
  openedMenuId.value = sessionId
}

/** 全局点击，若点在菜单/更多按钮/侧边栏外则关闭菜单。 */
function handleGlobalDocClick(event: MouseEvent) {
  if (!openedMenuId.value) return
  const t = event.target as Node | null
  if (t == null) return closeMenu()
  // 菜单通过 Teleport 渲染到 body；只要 target 不在"菜单 body"里也不在"更多按钮/sidebar"里就关闭
  const menuEl = document.getElementById('sidebar-item-menu')
  if (menuEl && menuEl.contains(t)) return
  if (sidebarRef.value && sidebarRef.value.contains(t)) {
    // 在 sidebar 内点击，但只要不是点到 more-btn，就关菜单
    const moreBtn = (t as HTMLElement).closest('[data-more-btn]')
    if (!moreBtn) closeMenu()
    return
  }
  closeMenu()
}

onMounted(() => {
  document.addEventListener('click', handleGlobalDocClick)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', handleGlobalDocClick)
})

/* -------------------------------------------------------------------------- */
/*  3. 功能实现：重命名 / 置顶 / 单删 / 多选进入                                */
/* -------------------------------------------------------------------------- */
async function startRename(session: SessionWithPinned) {
  closeMenu()
  editingSessionId.value = session.id
  editingTitle.value = session.title || '新对话'
  await nextTick()
  // ref 在 v-for 内会被 Vue 收集为数组，兼容取首个元素
  const el = editingInputRef.value as HTMLInputElement | HTMLInputElement[] | null
  const input = Array.isArray(el) ? el[0] : el
  input?.focus()
  input?.select()
}

function cancelRename() {
  editingSessionId.value = ''
  editingTitle.value = ''
}

async function saveRename() {
  if (!editingSessionId.value || isSavingTitle.value) return
  const id = editingSessionId.value
  const nextTitle = editingTitle.value.trim() || '新对话'
  const target = sessionStore.sessionMap[id]
  if (!target) return cancelRename()
  isSavingTitle.value = true
  try {
    await updateSessionTitle(id, nextTitle)
    sessionStore.updateSessionTitleLocal(id, nextTitle)
    cancelRename()
  } catch (error) {
    console.error(error)
    window.alert('修改标题失败，请稍后重试。')
  } finally {
    isSavingTitle.value = false
  }
}

async function togglePin(session: SessionWithPinned) {
  closeMenu()
  if (isPinningSession.value) return
  isPinningSession.value = true
  try {
    const nextPinned = !session.pinned
    await pinSession(session.id, nextPinned)
    // 本地同步：Session + pinned 字段
    const cur = sessionStore.sessionMap[session.id] as SessionWithPinned | undefined
    if (cur) {
      sessionStore.saveSession({ ...cur, pinned: nextPinned, updatedAt: new Date().toISOString() })
    }
    ElMessage.success(nextPinned ? '已置顶' : '已取消置顶')
  } catch (error) {
    console.error(error)
    ElMessage.error('置顶操作失败，请稍后重试。')
  } finally {
    isPinningSession.value = false
  }
}

function enterMultiSelect(session: SessionWithPinned) {
  closeMenu()
  isMultiSelectMode.value = true
  selectedIds.value = { [session.id]: true }
}

function exitMultiSelect() {
  isMultiSelectMode.value = false
  selectedIds.value = {}
}

function toggleSelected(sessionId: string) {
  if (selectedIds.value[sessionId]) delete selectedIds.value[sessionId]
  else selectedIds.value[sessionId] = true
  selectedIds.value = { ...selectedIds.value }
}

async function handleDeleteOne(session: SessionWithPinned) {
  closeMenu()
  if (isDeletingSession.value) return
  try {
    await ElMessageBox.confirm('确定删除该会话吗？删除后无法恢复。', '删除会话', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  isDeletingSession.value = true
  try {
    await deleteSession(session.id)
    sessionStore.removeSession(session.id)
    if (router.currentRoute.value.params.sessionID === session.id) {
      router.push({ name: 'home' })
    }
    ElMessage.success('已删除')
  } catch (error) {
    console.error(error)
    ElMessage.error('删除会话失败，请稍后重试。')
  } finally {
    isDeletingSession.value = false
  }
}

/* -------------------------------------------------------------------------- */
/*  4. 多选批量：置顶 / 删除（红色）                                           */
/* -------------------------------------------------------------------------- */
async function handleBulkPin(nextPinned: boolean) {
  const ids = Object.keys(selectedIds.value).filter((k) => selectedIds.value[k])
  if (!ids.length) return
  if (isBulkProcessing.value) return
  isBulkProcessing.value = true
  try {
    await batchPinSessions(ids, nextPinned)
    for (const id of ids) {
      const cur = sessionStore.sessionMap[id] as SessionWithPinned | undefined
      if (cur) sessionStore.saveSession({ ...cur, pinned: nextPinned, updatedAt: new Date().toISOString() })
    }
    ElMessage.success(nextPinned ? `已置顶 ${ids.length} 个对话` : `已取消置顶 ${ids.length} 个对话`)
    exitMultiSelect()
  } catch (error) {
    console.error(error)
    ElMessage.error('批量置顶失败，请稍后重试。')
  } finally {
    isBulkProcessing.value = false
  }
}

async function handleBulkDelete() {
  const ids = Object.keys(selectedIds.value).filter((k) => selectedIds.value[k])
  if (!ids.length) return
  try {
    await ElMessageBox.confirm(
      `确定删除已选择的 ${ids.length} 个对话吗？删除后无法恢复。`,
      '批量删除',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' },
    )
  } catch {
    return
  }
  if (isBulkProcessing.value) return
  isBulkProcessing.value = true
  try {
    await batchDeleteSessions(ids)
    let shouldGoHome = false
    for (const id of ids) {
      sessionStore.removeSession(id)
      if (router.currentRoute.value.params.sessionID === id) shouldGoHome = true
    }
    if (shouldGoHome) router.push({ name: 'home' })
    ElMessage.success(`已删除 ${ids.length} 个对话`)
    exitMultiSelect()
  } catch (error) {
    console.error(error)
    ElMessage.error('批量删除失败，请稍后重试。')
  } finally {
    isBulkProcessing.value = false
  }
}

/* -------------------------------------------------------------------------- */
/*  5. 导航 / 跳转                                                             */
/* -------------------------------------------------------------------------- */
const goToHomeIfNeeded = () => {
  if (props.onNavigateHome) {
    props.onNavigateHome()
    return
  }
  if (router.currentRoute.value.name === 'home') return
  router.push({ name: 'home' })
}

const toggleCollapse = () => emit('toggleCollapse')

function onItemClick(session: SessionWithPinned) {
  if (editingSessionId.value === session.id) return
  if (isMultiSelectMode.value) {
    toggleSelected(session.id)
    return
  }
  router.push({ name: 'chat', params: { sessionID: session.id } })
}

/* -------------------------------------------------------------------------- */
/*  菜单定位计算（Teleport 到 body，用 fixed 避免 overflow 裁剪）              */
/* -------------------------------------------------------------------------- */
const menuStyle = computed<Record<string, string>>(() => {
  if (!menuTriggerRect.value) return { display: 'none' } as Record<string, string>
  const MENU_W = 156
  // 左侧与 more-btn 左对齐后，再往左偏移 10px；顶部保持按钮下方 4px。
  let left = menuTriggerRect.value.left - 10
  const top = menuTriggerRect.value.top + menuTriggerRect.value.height + 4
  if (left + MENU_W > window.innerWidth - 8) {
    left = window.innerWidth - MENU_W - 8
  }
  if (left < 8) left = 8
  return {
    top: `${top}px`,
    left: `${left}px`,
    width: `${MENU_W}px`,
  }
})

/* 当前弹出菜单对应的会话对象（供 Teleport 内模板使用） */
const openedMenuItem = computed<SessionWithPinned | undefined>(() => {
  if (!openedMenuId.value) return undefined
  return sessionStore.sessionMap[openedMenuId.value] as SessionWithPinned | undefined
})

function onMenuStartRename() {
  const s = openedMenuItem.value
  if (s) startRename(s)
}
function onMenuTogglePin() {
  const s = openedMenuItem.value
  if (s) togglePin(s)
}
function onMenuEnterMulti() {
  const s = openedMenuItem.value
  if (s) enterMultiSelect(s)
}
function onMenuDeleteOne() {
  const s = openedMenuItem.value
  if (s) handleDeleteOne(s)
}
</script>

<template>
  <aside ref="sidebarRef" class="sidebar" :class="{ collapsed: collapsed }">
    <!-- 顶部栏：默认显示品牌 + 折叠按钮；多选模式下不再替换整栏，保持 logo/按钮不动，
         multi-top 放到下方，覆盖 new-chat-btn（见样式 .multi-top-overlay）。 -->
    <div class="sidebar-header">
      <div class="brand" :class="{ 'brand-collapsed': collapsed }" @click="goToHomeIfNeeded" title="返回首页">
        <span class="brand-mark">YQ</span>
        <span :class="['brand-text', { visible: !collapsed, hidden: collapsed }]">元启</span>
      </div>
      <button class="header-icon" :aria-label="collapsed ? '展开侧边栏' : '收起侧边栏'" @click="toggleCollapse">
        {{ collapsed ? '→' : '←' }}
      </button>
    </div>

    <!-- 固定高度容器：multi-top 与 new-chat-btn 绝对定位重叠，
         切换多选时容器高度恒定 46px，对话列表零位移。 -->
    <div class="new-chat-slot">
      <transition name="fade">
        <div v-if="isMultiSelectMode" class="multi-top multi-top-overlay">
          <span class="multi-top-title">用户已选择 <b>{{ selectedCount }}</b> 个对话</span>
          <button class="header-icon multi-close" aria-label="关闭多选" @click="exitMultiSelect">
            <el-icon><Close /></el-icon>
          </button>
        </div>
      </transition>

      <button class="new-chat-btn" :class="{ 'icon-only': collapsed }" @click="goToHomeIfNeeded">
        <el-icon><CirclePlus /></el-icon>
        <span v-show="!collapsed" class="new-chat-label">开启新对话</span>
      </button>
    </div>

    <!-- 会话列表滚动区（多选时底部留空给批量按钮栏） -->
    <div v-show="!collapsed" class="chat-scroll" :class="{ 'has-bottom-bar': isMultiSelectMode }">
      <template v-if="groupedSections.length">
        <div v-for="section in groupedSections" :key="section.key" class="chat-group">
          <div class="group-label">{{ section.label }}</div>
          <div v-for="item in section.items" :key="item.id"
            :class="[
              'chat-item',
              item.id === activeSessionId ? 'active' : '',
              { pinned: item.pinned, hovered: hoveredItemId === item.id }
            ]"
            @click="onItemClick(item)"
            @mouseenter="hoveredItemId = item.id"
            @mouseleave="hoveredItemId = ''"
          >
            <!-- 多选勾选框：常驻渲染保留占位（18px+gap），通过 .visible 类切换可见性，
                 避免进入/退出多选时 display 切换导致标题列整体横移抖动。 -->
            <div class="check-wrap" :class="{ visible: isMultiSelectMode }" @click.stop>
              <div class="round-check" :class="{ checked: !!selectedIds[item.id] }" @click.stop="toggleSelected(item.id)">
                <span v-if="selectedIds[item.id]">✓</span>
              </div>
            </div>

            <template v-if="editingSessionId === item.id">
              <input
                ref="editingInputRef"
                v-model="editingTitle"
                class="title-editor"
                :disabled="isSavingTitle"
                @click.stop
                @keydown.enter.prevent="saveRename"
                @keydown.esc.prevent="cancelRename"
                @blur="saveRename"
              />
            </template>
            <span v-else class="chat-title">{{ item.title }}</span>

            <!-- 三点按钮：常驻渲染保留占位（22px + gap 6px），仅在 hovered 且可操作时 opacity:1 可点，
                 其余状态 opacity:0 不可点 —— 避免 hover 瞬间 DOM 增删导致 flex 重排抖动。 -->
            <button
              type="button"
              class="more-btn"
              data-more-btn
              :class="{ shown: !isMultiSelectMode && editingSessionId !== item.id && (hoveredItemId === item.id || item.id === activeSessionId) }"
              aria-label="更多操作"
              :disabled="isSavingTitle || isDeletingSession || isPinningSession || isMultiSelectMode || editingSessionId === item.id"
              @click.stop="onMoreBtnClick($event, item.id)"
            >
              <i class="dot"></i><i class="dot"></i><i class="dot"></i>
            </button>
          </div>
        </div>
      </template>
      <div v-else class="empty-history">
        <span>暂无历史对话</span>
      </div>
    </div>

    <!-- 多选模式底部：置顶 / 删除按钮栏 -->
    <div v-if="isMultiSelectMode" class="multi-bottom">
      <button class="btn-pin" type="button" :disabled="!selectedCount || isBulkProcessing"
        @click="handleBulkPin(true)">
        <svg t="1787627887044" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="6940" width="200" height="200"><path d="M916.8 380.8L645 109.4c-7.2-7.2-16.5-10.7-25.9-10.7-9.4 0-18.8 3.5-25.9 10.7L415.5 286.9c-13.5-1.5-27-2.2-40.6-2.2-80.7 0-161.5 26.5-227.8 79.6-17 13.5-18.4 39-3 54.4l200.4 200.1L106.9 856c-2.9 2.9-4.7 6.7-5.1 10.8l-3.7 41c-1 10.4 7.3 19.2 17.5 19.2 0.6 0 1.1 0 1.7-0.1l41-3.7c4.1-0.3 7.9-2.2 10.8-5.1l237.6-237.3 200.4 200.1c7.2 7.2 16.5 10.7 25.9 10.7 10.7 0 21.3-4.6 28.6-13.7 62.1-77.4 87.9-174.4 77.4-268.1l177.7-177.4c14.4-14.2 14.4-37.3 0.1-51.6zM682.9 553.9l-27 27 4.2 37.9c4.1 37.1 1.1 74-9 109.8-6 20.9-14.1 40.9-24.5 59.7L237 399.2c14.2-7.8 29-14.4 44.5-19.7 30-10.4 61.4-15.5 93.4-15.5 10.6 0 21.3 0.5 31.9 1.8l37.9 4.2 174.5-174.3 211.2 210.9-147.5 147.3z m0 0" fill="#666666" p-id="6941"></path></svg>
        置顶
      </button>
      <button class="btn-delete" type="button" :disabled="!selectedCount || isBulkProcessing"
        @click="handleBulkDelete">
        <svg class="menu-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 4.5H13M6 4.5V3C6 2.4 6.4 2 7 2H9C9.6 2 10 2.4 10 3V4.5M4.5 4.5L5 14C5 14.6 5.4 15 6 15H10C10.6 15 11 14.6 11 14L11.5 4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        删除
      </button>
    </div>

    <!-- 用户头像 footer（多选模式时被 bottom-bar 占用，隐藏给它让位） -->
    <div v-if="!isMultiSelectMode" class="sidebar-footer">
      <div class="user-avatar">◔</div>
    </div>
  </aside>

  <!-- 更多菜单：Teleport 到 body，position: fixed，避免侧栏 overflow 裁剪 -->
  <Teleport to="body">
    <div v-if="openedMenuId && menuTriggerRect" id="sidebar-item-menu" class="item-menu-popover" :style="menuStyle">
      <button type="button" class="menu-item" @click.stop="onMenuStartRename">
        <svg class="menu-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11.5 1.5L14.5 4.5L5 14L2 14L2 11L11.5 1.5Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M9.5 3.5L12.5 6.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        <span>重命名</span>
      </button>
      <button type="button" class="menu-item" @click.stop="onMenuTogglePin">
        <svg t="1787627887044" class="icon" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg" p-id="6940" width="200" height="200"><path d="M916.8 380.8L645 109.4c-7.2-7.2-16.5-10.7-25.9-10.7-9.4 0-18.8 3.5-25.9 10.7L415.5 286.9c-13.5-1.5-27-2.2-40.6-2.2-80.7 0-161.5 26.5-227.8 79.6-17 13.5-18.4 39-3 54.4l200.4 200.1L106.9 856c-2.9 2.9-4.7 6.7-5.1 10.8l-3.7 41c-1 10.4 7.3 19.2 17.5 19.2 0.6 0 1.1 0 1.7-0.1l41-3.7c4.1-0.3 7.9-2.2 10.8-5.1l237.6-237.3 200.4 200.1c7.2 7.2 16.5 10.7 25.9 10.7 10.7 0 21.3-4.6 28.6-13.7 62.1-77.4 87.9-174.4 77.4-268.1l177.7-177.4c14.4-14.2 14.4-37.3 0.1-51.6zM682.9 553.9l-27 27 4.2 37.9c4.1 37.1 1.1 74-9 109.8-6 20.9-14.1 40.9-24.5 59.7L237 399.2c14.2-7.8 29-14.4 44.5-19.7 30-10.4 61.4-15.5 93.4-15.5 10.6 0 21.3 0.5 31.9 1.8l37.9 4.2 174.5-174.3 211.2 210.9-147.5 147.3z m0 0" fill="#666666" p-id="6941"></path></svg>
        <span>{{ openedMenuItem?.pinned ? '取消置顶' : '置顶' }}</span>
      </button>
      <button type="button" class="menu-item" @click.stop="onMenuEnterMulti">
        <svg class="menu-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/><rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" stroke-width="1.3"/></svg>
        <span>多选</span>
      </button>
      <div class="menu-sep"></div>
      <button type="button" class="menu-item danger" @click.stop="onMenuDeleteOne">
        <svg class="menu-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 4.5H13M6 4.5V3C6 2.4 6.4 2 7 2H9C9.6 2 10 2.4 10 3V4.5M4.5 4.5L5 14C5 14.6 5.4 15 6 15H10C10.6 15 11 14.6 11 14L11.5 4.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span>删除</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.sidebar {
  position: fixed;
  top: 0;
  left: 0;
  /* 用父级 .deepseek-app 设置的 --sidebar-width 变量，fallback 240px。
     之前在子规则里硬写 --sidebar-width:240px 覆盖了父级继承值，
     导致 collapsed 时父传 92px 被忽略，侧边栏收不起来。 */
  width: var(--sidebar-width, 240px);
  max-width: var(--sidebar-width, 240px);
  height: 100vh;
  padding: 12px 10px 10px;
  border-right: 1px solid rgba(15, 23, 42, 0.06);
  background: #f7f7f8;
  display: flex;
  flex-direction: column;
  transition: width 0.28s ease, max-width 0.28s ease, padding 0.28s ease, transform 0.28s ease;
  box-sizing: border-box;
  overflow: hidden;
  z-index: 60;
}

.sidebar.collapsed {
  padding: 12px 8px 10px;
  /* collapsed 时在子级也显式设置 width:92px，双重保险：
     1) 父级 MainLayout 传来的 --sidebar-width:92px 生效（主路径）
     2) 这里兜底写死，防止父级漏传时仍旧不收 */
  width: 92px;
  max-width: 92px;
}

/* ---------- 顶部 ---------- */
.sidebar-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 4px 14px;
  z-index: 2;
}

/* 固定高度容器：new-chat-btn(34px) + margin-bottom(12px) = 46px 恒定不变。
   multi-top 与 new-chat-btn 绝对定位重叠，切换时容器高度零变化 → 列表不抖。 */
.new-chat-slot {
  position: relative;
  height: 46px;
  margin-bottom: 0;
}

/* 多选顶部：绝对定位铺满容器，淡入淡出不影响布局 */
.multi-top-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 46px;
  padding: 6px 8px;
  background: #f7f7f8;
  z-index: 2;
  box-sizing: border-box;
}

/* new-chat-btn：绝对定位，margin-bottom 吸收进容器 */
.new-chat-slot .new-chat-btn {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  margin-bottom: 0;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(-3px);
}

/* 多选模式顶部通用布局 */
.multi-top {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  box-sizing: border-box;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  font-size: 1.05rem;
  color: #0f172a;
  cursor: pointer;
  min-width: 0;
}
.brand-collapsed { justify-content: flex-start; width: auto; }
.brand-mark {
  display: inline-flex;
  align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 9px;
  background: linear-gradient(135deg, #4ca3ff, #2f71ff);
  color: #fff; font-size: 0.68rem; font-weight: 700;
  letter-spacing: 0.04em;
  box-shadow: 0 8px 20px rgba(73, 124, 255, 0.22);
  flex-shrink: 0;
}
.brand-text {
  font-size: 1.05rem;
  letter-spacing: -0.03em;
  color: #0f172a;
  white-space: nowrap;
  opacity: 0;
  transform: translateX(-6px);
  pointer-events: none;
  transition: opacity 0.22s ease, transform 0.22s ease;
}
.brand-text.visible { opacity: 1; transform: translateX(0); pointer-events: auto; }
.brand-text.hidden { opacity: 0; transform: translateX(-6px); pointer-events: none; }

.header-icon {
  width: 28px; height: 28px;
  border-radius: 8px;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: rgba(255, 255, 255, 0.55);
  color: #475569;
  flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  font-size: 0.85rem;
}

/* 多选模式顶部 */
.multi-top {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.multi-top-title {
  font-size: 0.84rem;
  color: #0f172a;
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.multi-top-title b {
  color: #2563eb;
  margin: 0 2px;
  font-weight: 700;
}
.multi-close {
  border-color: rgba(59, 130, 246, 0.18);
  color: #475569;
}

/* ---------- 新对话按钮 ---------- */
.new-chat-btn {
  height: 40px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: rgba(255, 255, 255, 0.72);
  border-radius: 100px;
  color: #1f2937;
  font-size: 0.82rem;
  font-weight: 500;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-bottom: 12px;
  padding: 0 10px;
  transition: all 0.22s ease;
  overflow: hidden;
  white-space: nowrap;
  cursor: pointer;
}
.new-chat-btn:hover {
  background: rgba(91, 140, 255, 0.08);
  border-color: rgba(91, 140, 255, 0.25);
}
.new-chat-btn.icon-only {
  width: 100%;
  min-width: 36px;
  max-width: 36px;
  height: 32px;
  border-radius: 10px;
  padding: 0;
}
.new-chat-label {
  white-space: nowrap;
  display: inline-block;
}

/* ---------- 聊天项分组 ---------- */
.chat-scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 2px;
  min-height: 0;
}
.chat-scroll.has-bottom-bar {
  padding-bottom: 8px;
}
.chat-group {
  display: flex;
  flex-direction: column;
  margin-bottom: 10px;
}
.group-label {
  padding: 8px 10px 4px;
  font-size: 0.72rem;
  font-weight: 500;
  color: #64748b;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

/* ---------- 聊天项：字体/边距缩小 ---------- */
.chat-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  /* 内边距扣除 1px 预占位边框，总尺寸恒定；active/hover 只改 border-color，不改盒高 */
  padding: 6px 9px;
  min-height: 32px;
  border-radius: 10px;
  /* 1px 透明边框预占位；active/hover 时改成实色或保留透明，避免 inset-shadow 带来的视觉跳动 */
  border: 1px solid transparent;
  box-sizing: border-box;
  color: #3b475a;
  font-size: 0.82rem;
  line-height: 1.25;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.14s ease, color 0.14s ease, border-color 0.14s ease;
}
.chat-item:hover {
  background: rgba(15, 23, 42, 0.04);
  color: #0f172a;
}
.chat-item.active {
  background: rgba(111, 156, 255, 0.18);
  color: #1d4ed8;
  border-color: rgba(59, 130, 246, 0.18);
}
.chat-item.pinned .chat-title {
  font-weight: 500;
}

.chat-title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 勾选框（多选模式）：常驻渲染保留 18px 占位，通过 .visible 类切换可见性，
   避免进入/退出多选时 display 切换导致标题列整体横移抖动。 */
.check-wrap {
  display: inline-flex;
  flex: 0 0 auto;
  width: 18px;
  height: 18px;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 0.15s ease, visibility 0s linear 0.15s;
}
.check-wrap.visible {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transition: opacity 0.15s ease, visibility 0s linear;
}
.round-check {
  width: 18px;
  height: 18px;
  border-radius: 999px;
  border: 1.5px solid #cbd5e1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #fff;
  color: #fff;
  font-size: 0.72rem;
  cursor: pointer;
  transition: all 0.15s ease;
}
.round-check.checked {
  background: #3b82f6;
  border-color: #3b82f6;
}

/* 三点按钮：常驻渲染保留占位，未 shown 时 opacity:0+不可点，shown 时淡入；
   避免 hover 时 DOM 增删导致 flex 重排、标题截断点变化造成的抖动。 */
.more-btn {
  flex-shrink: 0;
  width: 22px; height: 22px;
  border-radius: 50%;
  border: 0;
  background: transparent;
  color: #64748b;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 0;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: opacity 0.14s ease, background-color 0.14s ease, color 0.14s ease, visibility 0s linear;
}
.more-btn.shown {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}
.more-btn:hover {
  background: rgba(15, 23, 42, 0.06);
  color: #0f172a;
}
.more-btn .dot {
  display: inline-block;
  width: 3px; height: 3px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.85;
}

.title-editor {
  flex: 1;
  min-width: 0;
  border: 1px solid rgba(59, 130, 246, 0.32);
  border-radius: 8px;
  padding: 3px 8px;
  font-size: 0.82rem;
  line-height: 1.2;
  background: #fff;
}

/* ---------- 多选模式底部按钮栏 ---------- */
.multi-bottom {
  display: flex;
  gap: 8px;
  padding: 10px 6px 8px;
  border-top: 1px solid rgba(15, 23, 42, 0.06);
}
.multi-bottom > button {
  flex: 1;
  height: 30px;
  border-radius: 8px;
  border: 1px solid rgba(15, 23, 42, 0.1);
  background: #fff;
  font-size: 0.82rem;
  cursor: pointer;
  transition: all 0.15s ease;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
/* 批量按钮内的 SVG 统一约束到 14px，兼容 200x200 的 iconfont 和 16x16 的普通 SVG */
.multi-bottom > button svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  display: block;
}
.multi-bottom .btn-pin {
  color: #0f172a;
}
.multi-bottom .btn-pin:hover:not(:disabled) {
  border-color: rgba(59, 130, 246, 0.3);
  color: #1d4ed8;
  background: rgba(59, 130, 246, 0.06);
}
.multi-bottom .btn-delete {
  color: #dc2626;
  border-color: rgba(239, 68, 68, 0.2);
  background: rgba(239, 68, 68, 0.04);
}
.multi-bottom .btn-delete:hover:not(:disabled) {
  color: #b91c1c;
  background: rgba(239, 68, 68, 0.08);
  border-color: rgba(239, 68, 68, 0.35);
}
.multi-bottom button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ---------- 用户 footer ---------- */
.sidebar-footer {
  margin-top: auto;
  padding: 10px 8px 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-top: 1px solid rgba(15, 23, 42, 0.05);
}
.user-avatar {
  width: 26px; height: 26px;
  border-radius: 50%;
  background: rgba(15, 23, 42, 0.08);
  display: grid; place-items: center;
  color: #475569;
  font-size: 0.95rem;
}

.empty-history {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(15, 23, 42, 0.38);
  font-size: 0.82rem;
  padding: 20px 10px;
}

/* ---------- 菜单弹层（Teleport 到 body，fixed 定位） ---------- */
</style>

<!-- 菜单样式放到全局：Teleport 到 body 后 scoped 不生效 -->
<style>
.item-menu-popover {
  position: fixed;
  z-index: 9999;
  background: #ffffff;
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 10px;
  padding: 6px;
  box-shadow: 0 12px 30px rgba(15, 23, 42, 0.12);
  display: flex;
  flex-direction: column;
  gap: 1px;
  animation: menuFadeIn 0.12s ease-out;
}
@keyframes menuFadeIn {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}
.item-menu-popover .menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  padding: 7px 10px;
  border: 0;
  background: transparent;
  border-radius: 6px;
  font-size: 0.84rem;
  color: #0f172a;
  cursor: pointer;
  white-space: nowrap;
}
.menu-icon,
.item-menu-popover .menu-item svg.icon {
  flex-shrink: 0;
  color: currentColor;
  /* 用户自带的 SVG 是 200x200，统一约束到 16px 与 menu-icon 一致 */
  width: 16px;
  height: 16px;
  display: block;
}
.item-menu-popover .menu-item:hover {
  background: rgba(15, 23, 42, 0.05);
}
.item-menu-popover .menu-item.danger {
  color: #dc2626;
}
.item-menu-popover .menu-item.danger:hover {
  background: rgba(239, 68, 68, 0.08);
  color: #b91c1c;
}
.item-menu-popover .menu-sep {
  height: 1px;
  background: rgba(15, 23, 42, 0.07);
  margin: 4px 2px;
}
</style>
