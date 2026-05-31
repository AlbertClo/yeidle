<script setup lang="ts">
import type { ListboxContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { ListboxContent, useForwardProps } from "reka-ui"
import { cn } from "@/lib/utils"

const props = defineProps<ListboxContentProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardProps(delegatedProps)
</script>

<template>
  <ListboxContent
    data-slot="command-list"
    v-bind="forwarded"
    :class="cn('command-list max-h-[400px] scroll-py-1 overflow-x-hidden overflow-y-auto', props.class)"
  >
    <div role="presentation">
      <slot />
    </div>
  </ListboxContent>
</template>

<style scoped>
.command-list::-webkit-scrollbar {
  width: 6px;
}
.command-list::-webkit-scrollbar-track {
  background: transparent;
}
.command-list::-webkit-scrollbar-thumb {
  background: hsl(var(--border));
  border-radius: 3px;
}
.command-list::-webkit-scrollbar-thumb:hover {
  background: hsl(var(--muted-foreground));
}
</style>
