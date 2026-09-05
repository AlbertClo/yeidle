<script setup lang="ts">
import { ArrowLeft, ArrowRight } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { navigateBack, navigateForward } from '@/navigation/historyNavigation';
import { bindingLabel } from '@/stores/keyBindings';
</script>

<template>
    <div class="flex items-center" role="group" aria-label="Navigation history">
        <Button
            variant="ghost"
            size="icon"
            class="h-7 w-7"
            :title="`Back (${bindingLabel('back')})`"
            aria-label="Navigate back"
            @click="navigateBack"
        >
            <ArrowLeft class="size-4" />
        </Button>
        <Button
            variant="ghost"
            size="icon"
            class="h-7 w-7"
            :title="`Forward (${bindingLabel('forward')})`"
            aria-label="Navigate forward"
            @click="navigateForward"
        >
            <ArrowRight class="size-4" />
        </Button>
    </div>
</template>
