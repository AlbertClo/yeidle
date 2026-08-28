<script setup lang="ts">
import { Head, Link } from '@inertiajs/vue3';
import AppLogoIcon from '@/components/AppLogoIcon.vue';
import { dashboard, login, register } from '@/routes';
</script>

<template>
    <Head title="Yeidle" />

    <main class="min-h-svh bg-background text-foreground">
        <nav class="mx-auto flex h-16 max-w-6xl items-center px-6">
            <Link href="/" class="flex items-center gap-3 font-semibold">
                <AppLogoIcon class="size-7" />
                <span>Yeidle</span>
            </Link>
            <div class="ml-auto flex items-center gap-2">
                <Link
                    v-if="$page.props.auth.user"
                    :href="dashboard()"
                    class="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background"
                >
                    Open account
                </Link>
                <template v-else>
                    <Link :href="login()" class="rounded-md px-4 py-2 text-sm font-medium hover:bg-muted">
                        Log in
                    </Link>
                    <Link
                        :href="register()"
                        class="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background"
                    >
                        Create account
                    </Link>
                </template>
            </div>
        </nav>

        <section class="mx-auto flex max-w-4xl flex-col items-center px-6 py-28 text-center md:py-40">
            <AppLogoIcon class="mb-8 size-16" />
            <h1 class="max-w-3xl text-4xl font-semibold tracking-tight md:text-6xl">
                Your notes, local first and available everywhere.
            </h1>
            <p class="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
                Yeidle is a fast connected-notes workspace with offline editing,
                realtime sync, and a direct path from your Roam Research database.
            </p>
            <div class="mt-10 flex items-center gap-3">
                <Link
                    v-if="$page.props.auth.user"
                    :href="dashboard()"
                    class="rounded-md bg-foreground px-5 py-3 font-medium text-background"
                >
                    Manage your account
                </Link>
                <template v-else>
                    <Link
                        :href="register()"
                        class="rounded-md bg-foreground px-5 py-3 font-medium text-background"
                    >
                        Create your account
                    </Link>
                    <Link :href="login()" class="rounded-md border px-5 py-3 font-medium hover:bg-muted">
                        Log in
                    </Link>
                </template>
            </div>
        </section>
    </main>
</template>
