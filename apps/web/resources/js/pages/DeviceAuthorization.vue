<script setup lang="ts">
import { Head, router } from '@inertiajs/vue3';
import { MonitorSmartphone, ShieldCheck } from '@lucide/vue';
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
    <Head title="Connect a device" />

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
                    <MonitorSmartphone v-else class="size-6" />
                </div>
                <CardTitle>
                    {{
                        authorization.approved
                            ? 'Device connected'
                            : 'Connect a device'
                    }}
                </CardTitle>
                <CardDescription v-if="authorization.expired">
                    This connection request has expired. Return to Yeidle and
                    try again.
                </CardDescription>
                <CardDescription v-else-if="authorization.approved">
                    <strong>{{ authorization.device_name }}</strong> is signed
                    in. Return to Yeidle; you can close this page.
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
                    {{ approving ? 'Connecting…' : 'Connect device' }}
                </Button>
            </CardFooter>
        </Card>
    </div>
</template>
