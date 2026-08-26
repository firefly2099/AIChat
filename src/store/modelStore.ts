// 模型选项 store：拉取并缓存可用模型列表，维护当前选中模型。
import { defineStore } from 'pinia'
import { fetchModels as fetchModelsApi, type ApiModel } from '../api/chatApi'

export type ModelOption = ApiModel

export const useModelStore = defineStore('model', {
  state: () => ({
    modelOptions: [] as ModelOption[],
    selectedModel: '',
    isFetchingModels: false,
    hasFetchedModels: false,
  }),
  getters: {
    currentModel(state) {
      return state.modelOptions.find((model) => model.id === state.selectedModel) ?? state.modelOptions[0] ?? null
    },
  },
  actions: {
    async fetchModels(force = false) {
      if (this.isFetchingModels) {
        return
      }

      if (this.hasFetchedModels && !force) {
        return
      }

      this.isFetchingModels = true

      try {
        const nextModels = await fetchModelsApi()
        this.modelOptions = nextModels

        if (!nextModels.some((model) => model.id === this.selectedModel)) {
          this.selectedModel = nextModels[0]?.id ?? ''
        }

        this.hasFetchedModels = true
      } catch (error) {
        console.warn('Failed to fetch models, keep empty model list:', error)
        this.modelOptions = []
        this.selectedModel = ''
      } finally {
        this.isFetchingModels = false
      }
    },
    setSelectedModel(modelId: string) {
      this.selectedModel = String(modelId || '').trim()
    },
  },
})
