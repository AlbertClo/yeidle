<?php

namespace App\Console\Commands;

use App\Models\User;
use Illuminate\Console\Command;

class IssueApiToken extends Command
{
    protected $signature = 'token:issue {email : Email of the user to issue a token for}
        {--name=desktop : Token name}';

    protected $description = 'Issue a personal access token for a user (paste it into the desktop app)';

    public function handle(): int
    {
        $user = User::where('email', $this->argument('email'))->first();

        if (! $user) {
            $this->error("No user with email {$this->argument('email')}.");

            return self::FAILURE;
        }

        $token = $user->createToken($this->option('name'))->plainTextToken;

        $this->info('Token (shown once):');
        $this->line($token);

        return self::SUCCESS;
    }
}
