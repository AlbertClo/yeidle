<script setup lang="ts">
import { Head, router, useForm } from '@inertiajs/vue3';
import { Laptop, Plus, Users } from '@lucide/vue';
import { ref } from 'vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { dashboard } from '@/routes';

defineProps<{
    workspaces: Array<{
        id: string;
        name: string;
        role: string;
        owned: boolean;
    }>;
    devices: Array<{
        id: number;
        name: string;
        last_used_at: string | null;
        created_at: string | null;
    }>;
}>();

defineOptions({
    layout: {
        breadcrumbs: [{ title: 'Account', href: dashboard() }],
    },
});

const creating = ref(false);
const form = useForm({ name: '' });

function createWorkspace(): void {
    form.post('/workspaces', {
        preserveScroll: true,
        onSuccess: () => {
            form.reset();
            creating.value = false;
        },
    });
}

function revokeDevice(id: number): void {
    router.delete(`/devices/${id}`, { preserveScroll: true });
}

function formatDate(value: string | null): string {
    if (!value) {
        return 'Never used';
    }

    return new Date(value).toLocaleString();
}
</script>

<template>
    <Head title="Your Yeidle account" />

    <div class="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 p-6">
        <div>
            <h1 class="text-2xl font-semibold">Your Yeidle account</h1>
            <p class="mt-1 text-sm text-muted-foreground">
                Workspaces listed here become available automatically when you sign in on a device.
            </p>
        </div>

        <Card>
            <CardHeader class="flex-row items-start justify-between gap-4">
                <div>
                    <CardTitle>Workspaces</CardTitle>
                    <CardDescription>Owned and shared workspaces.</CardDescription>
                </div>
                <Button size="sm" @click="creating = !creating">
                    <Plus /> New workspace
                </Button>
            </CardHeader>
            <CardContent class="space-y-3">
                <form
                    v-if="creating"
                    class="flex items-end gap-3 rounded-lg border p-3"
                    @submit.prevent="createWorkspace"
                >
                    <div class="flex-1 space-y-1.5">
                        <Label for="workspace-name">Workspace name</Label>
                        <Input id="workspace-name" v-model="form.name" autofocus maxlength="100" />
                        <p v-if="form.errors.name" class="text-xs text-destructive">
                            {{ form.errors.name }}
                        </p>
                    </div>
                    <Button type="submit" :disabled="form.processing || !form.name.trim()">
                        Create
                    </Button>
                </form>

                <div
                    v-for="workspace in workspaces"
                    :key="workspace.id"
                    class="flex items-center gap-3 rounded-lg border px-4 py-3"
                >
                    <Users class="size-4 text-muted-foreground" />
                    <span class="font-medium">{{ workspace.name }}</span>
                    <Badge variant="secondary" class="ml-auto capitalize">
                        {{ workspace.role }}
                    </Badge>
                </div>
            </CardContent>
        </Card>

        <Card>
            <CardHeader>
                <CardTitle>Connected devices</CardTitle>
                <CardDescription>
                    Signing out a device revokes its cloud access token. Local data stays on that device.
                </CardDescription>
            </CardHeader>
            <CardContent class="space-y-3">
                <div
                    v-if="devices.length === 0"
                    class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground"
                >
                    No desktop devices are connected yet.
                </div>
                <div
                    v-for="device in devices"
                    :key="device.id"
                    class="flex items-center gap-3 rounded-lg border px-4 py-3"
                >
                    <Laptop class="size-4 text-muted-foreground" />
                    <div>
                        <div class="font-medium">{{ device.name }}</div>
                        <div class="text-xs text-muted-foreground">
                            Last used {{ formatDate(device.last_used_at) }}
                        </div>
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        class="ml-auto text-destructive hover:text-destructive"
                        @click="revokeDevice(device.id)"
                    >
                        Sign out
                    </Button>
                </div>
            </CardContent>
        </Card>
    </div>
</template>
