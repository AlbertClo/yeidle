<script setup lang="ts">
import { Head, router } from '@inertiajs/vue3';
import { Laptop, ShieldCheck } from '@lucide/vue';
import { ref } from 'vue';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';

const props = defineProps<{
    authorization: {
        id: string;
        device_name: string;
        approved: boolean;
        expired: boolean;
    };
}>();
const approving = ref(false);

function approve(): void {
    if (approving.value || props.authorization.approved) {
        return;
    }

    approving.value = true;
    router.post(`/device/authorize/${props.authorization.id}`, undefined, {
        preserveScroll: true,
        onFinish: () => {
            approving.value = false;
        },
    });
}
</script>

<template>
    <Head title="Connect desktop app" />

    <div class="flex min-h-[70vh] items-center justify-center p-6">
        <Card class="w-full max-w-lg">
            <CardHeader class="text-center">
                <div
                    class="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-muted"
                >
                    <ShieldCheck
                        v-if="authorization.approved"
                        class="size-6 text-green-600"
                    />
                    <Laptop v-else class="size-6" />
                </div>
                <CardTitle>
                    {{
                        authorization.approved
                            ? 'Desktop connected'
                            : 'Connect Yeidle Desktop'
                    }}
                </CardTitle>
                <CardDescription v-if="authorization.expired">
                    This connection request has expired. Return to Yeidle and
                    try again.
                </CardDescription>
                <CardDescription v-else-if="authorization.approved">
                    You can return to Yeidle. This browser window may now be
                    closed.
                </CardDescription>
                <CardDescription v-else>
                    Allow <strong>{{ authorization.device_name }}</strong> to
                    access and synchronize your Yeidle workspaces.
                </CardDescription>
            </CardHeader>
            <CardContent
                v-if="!authorization.approved && !authorization.expired"
                class="text-sm text-muted-foreground"
            >
                Only approve this request if you initiated it from your own
                Yeidle app.
            </CardContent>
            <CardFooter v-if="!authorization.approved && !authorization.expired">
                <Button
                    class="w-full"
                    :disabled="approving"
                    @click="approve"
                >
                    {{ approving ? 'Connecting…' : 'Connect desktop app' }}
                </Button>
            </CardFooter>
        </Card>
    </div>
</template>
