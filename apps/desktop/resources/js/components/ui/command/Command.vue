<script setup lang="ts">
import type { ListboxRootEmits, ListboxRootProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { ListboxRoot, useFilter, useForwardPropsEmits } from "reka-ui"
import { reactive, ref, watch } from "vue"
import { cn } from "@/lib/utils"
import { provideCommandContext } from "."

const props = withDefaults(defineProps<ListboxRootProps & { class?: HTMLAttributes["class"] }>(), {
  modelValue: "",
})

const emits = defineEmits<ListboxRootEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)

const allItems = ref<Map<string, string>>(new Map())
const allGroups = ref<Map<string, Set<string>>>(new Map())

const { contains } = useFilter({ sensitivity: "base" })
const filterState = reactive({
  search: "",
  filtered: {
    /** The count of all visible items. */
    count: 0,
    /** Map from visible item id to its search score. */
    items: new Map() as Map<string, number>,
    /** Set of groups with at least one visible item. */
    groups: new Set() as Set<string>,
  },
})

function filterItems() {
  // Always show all items — filtering is handled server-side
  filterState.filtered.count = allItems.value.size
  for (const [id] of allItems.value) {
    filterState.filtered.items.set(id, 1)
  }
  for (const [groupId] of allGroups.value) {
    filterState.filtered.groups.add(groupId)
  }
}

watch(() => filterState.search, () => {
  filterItems()
})

watch([allItems, allGroups], () => {
  filterItems()
}, { deep: true })

provideCommandContext({
  allItems,
  allGroups,
  filterState,
})
</script>

<template>
  <ListboxRoot
    data-slot="command"
    v-bind="forwarded"
    :class="cn('bg-popover text-popover-foreground flex h-full w-full flex-col overflow-hidden rounded-md', props.class)"
  >
    <slot />
  </ListboxRoot>
</template>
