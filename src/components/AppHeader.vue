<script setup lang="ts">
import { ArrowDown } from '@element-plus/icons-vue'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useModelStore } from '../store/modelStore'

/**
 * 模型选择器下拉菜单关闭时的外部点击处理区域。
 */
const modelSwitcherArea = ref<HTMLElement | null>(null)

const modelStore = useModelStore()
const isModelMenuOpen = ref(false)

/**
 * 当前选中的模型对象，确保按钮中展示正确 label。
 */
const currentModel = computed(
  () => modelStore.currentModel,
)

const modelOptions = computed(() => modelStore.modelOptions)
const selectedModel = computed({
  get: () => modelStore.selectedModel,
  set: (value: string) => modelStore.setSelectedModel(value),
})

/**
 * 点击页面其他区域时关闭模型菜单。
 * @param {MouseEvent} event 点击事件对象
 */
const handleDocumentClick = (event: MouseEvent) => {
  if (!isModelMenuOpen.value) {
    return
  }

  const target = event.target
  if (target instanceof Node && modelSwitcherArea.value && !modelSwitcherArea.value.contains(target)) {
    isModelMenuOpen.value = false
  }
}

/**
 * 拉取后端真实模型列表，作为当前可选模型的来源。
 */
async function fetchModels() {
  await modelStore.fetchModels()
}

/**
 * 小屏侧边栏展开按钮。
 */
const emit = defineEmits<{
  (e: 'openMobileSidebar'): void
}>()

onMounted(() => {
  document.addEventListener('click', handleDocumentClick)
  void fetchModels()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleDocumentClick)
})
</script>

<template>
  <header class="workspace-header">
    <div class="header-actions header-left">
      <!-- 小屏侧边栏展开按钮 -->
      <button class="icon-btn mobile-sidebar-btn" aria-label="展开侧边栏" @click="emit('openMobileSidebar')">
        <span class="hamburger"><i></i><i></i><i></i></span>
      </button>

      <div ref="modelSwitcherArea" class="model-switcher-area">
        <button class="model-switcher" type="button" @click="isModelMenuOpen = !isModelMenuOpen">
          <span class="model-switcher-label">{{ currentModel?.label || '请选择模型' }}</span>
          <el-icon class="model-switcher-caret" :class="{ open: isModelMenuOpen }">
            <ArrowDown />
          </el-icon>
        </button>

        <div v-if="isModelMenuOpen" class="model-menu">
          <button
            v-for="model in modelOptions"
            :key="model.id"
            type="button"
            class="model-option"
            :class="{ active: selectedModel === model.id }"
            @click="selectedModel = model.id; isModelMenuOpen = false"
          >
            <span class="model-option-main">
              <span class="model-option-name">{{ model.label }}</span>
              <span v-if="selectedModel === model.id" class="model-option-check">✓</span>
            </span>
            <span class="model-option-desc">{{ model.description }}</span>
          </button>
        </div>
      </div>
    </div>
  </header>
</template>

<style scoped>
.workspace-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 24px 8px;
  min-height: 44px;
  max-height: 48px;
  background: rgba(255, 255, 255, 0.42);
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
  backdrop-filter: blur(6px);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 14px;
}
.header-left {
  flex: 1;
  min-width: 0;
}

.icon-btn {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: rgba(255, 255, 255, 0.7);
  color: #475569;
  cursor: pointer;
}
.icon-btn:hover {
  background: rgba(91, 140, 255, 0.08);
  border-color: rgba(91, 140, 255, 0.25);
  color: #1d4ed8;
}
.hamburger {
  display: inline-flex;
  flex-direction: column;
  gap: 3px;
  align-items: stretch;
  justify-content: center;
  width: 16px;
}
.hamburger i {
  display: inline-block;
  height: 1.8px;
  border-radius: 2px;
  background: currentColor;
}

/* 大屏（>900px）下隐藏展开按钮 */
.mobile-sidebar-btn {
  display: none;
}

.model-switcher-area {
  position: relative;
}

.model-switcher {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  width: auto;
  max-width: none;
  height: 34px;
  padding: 0 12px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.7);
  color: #1f2937;
  font-size: 1rem;
  font-weight: 600;
  box-shadow: 0 8px 16px rgba(15, 23, 42, 0.02);
  white-space: nowrap;
}

.model-switcher-label {
  line-height: 1.2;
  margin-right: 6px;
}

.model-switcher-caret {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.9rem;
  color: #475569;
  transform: rotate(0deg);
  transition: transform 0.2s ease;
}

.model-switcher-caret.open {
  transform: rotate(180deg);
}

.model-menu {
  position: absolute;
  top: calc(100% + 10px);
  left: 0;
  width: min(420px, 60vw);
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 12px;
  padding: 6px;
  box-shadow: 0 14px 32px rgba(15, 23, 42, 0.08);
  z-index: 100;
}

.model-option {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 8px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: #1f2937;
}
.model-option:hover { background: rgba(91, 140, 255, 0.06); }
.model-option.active { background: rgba(59, 130, 246, 0.1); }
.model-option-main {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-weight: 600;
}
.model-option-check { color: #2563eb; }
.model-option-desc {
  font-size: 0.82rem;
  color: #64748b;
  line-height: 1.3;
}

@media (max-width: 900px) {
  .workspace-header {
    padding: 10px 14px 8px;
  }
  .mobile-sidebar-btn {
    display: inline-flex;
  }
  .model-switcher {
    font-size: 0.92rem;
    padding: 0 10px;
    height: 32px;
  }
}
</style>
