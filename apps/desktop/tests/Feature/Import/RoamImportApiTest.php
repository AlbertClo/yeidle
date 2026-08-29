<?php

namespace Tests\Feature\Import;

use App\Models\Media;
use App\Models\Node;
use App\Workspaces\WorkspaceIndex;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Tests\TestCase;

class RoamImportApiTest extends TestCase
{
    private string $directory;

    private string $fixture;

    private string $originalDatabase;

    private string $originalStorageRoot;

    private WorkspaceIndex $workspaces;

    protected function setUp(): void
    {
        parent::setUp();

        $connection = config('database.default');
        $this->originalDatabase = (string) config("database.connections.{$connection}.database");
        $this->originalStorageRoot = (string) config('filesystems.disks.local.root');
        $this->directory = sys_get_temp_dir().'/yeidle-roam-api-'.Str::uuid();
        mkdir($this->directory, 0700, true);
        $baseDatabase = $this->directory.'/nativephp.sqlite';
        touch($baseDatabase);
        $this->workspaces = new WorkspaceIndex(
            $baseDatabase,
            $this->directory.'/personal-storage',
        );
        $this->app->instance(WorkspaceIndex::class, $this->workspaces);
        $this->fixture = base_path('tests/Fixtures/roam-export.json');
    }

    protected function tearDown(): void
    {
        $connection = config('database.default');
        DB::purge($connection);
        config(["database.connections.{$connection}.database" => $this->originalDatabase]);
        config(['filesystems.disks.local.root' => $this->originalStorageRoot]);
        Storage::forgetDisk('local');
        $this->deleteDirectory($this->directory);

        parent::tearDown();
    }

    public function test_it_imports_into_a_new_workspace_without_activating_it_early(): void
    {
        $initialActiveWorkspace = $this->workspaces->state()['active_workspace_id'];
        $uploadId = $this->upload(file_get_contents($this->fixture));

        $workspace = $this->postJson('/api/imports/roam/finish', [
            'upload_id' => $uploadId,
            'workspace_id' => null,
            'new_workspace_name' => 'Imported Roam',
            'download_attachments' => false,
        ])
            ->assertSuccessful()
            ->assertJsonPath('workspace.name', 'Imported Roam')
            ->assertJsonPath('report.Pages', 2)
            ->assertJsonPath('report.Blocks', 5)
            ->json('workspace');

        $this->assertSame($initialActiveWorkspace, $this->workspaces->state()['active_workspace_id']);
        $this->assertCount(2, $this->workspaces->all());
        $this->assertSame(7, Node::count());
        $this->assertSame(0, Media::count());
        $this->assertFileExists($this->workspaces->databasePath($workspace));
    }

    public function test_it_can_merge_an_import_into_an_existing_workspace(): void
    {
        $workspace = $this->workspaces->create('Existing');
        $uploadId = $this->upload(file_get_contents($this->fixture));

        $this->postJson('/api/imports/roam/finish', [
            'upload_id' => $uploadId,
            'workspace_id' => $workspace['id'],
            'new_workspace_name' => null,
            'download_attachments' => false,
        ])
            ->assertSuccessful()
            ->assertJsonPath('workspace.id', $workspace['id'])
            ->assertJsonPath('report.Nodes written', 7);

        $this->assertSame(7, Node::count());
        $this->assertCount(2, $this->workspaces->all());
    }

    public function test_stream_reports_preparation_node_progress_and_completion(): void
    {
        $uploadId = $this->upload(file_get_contents($this->fixture));

        $response = $this->postJson('/api/imports/roam/stream', [
            'upload_id' => $uploadId,
            'workspace_id' => null,
            'new_workspace_name' => 'Streamed Roam',
            'download_attachments' => false,
        ])->assertSuccessful();

        $events = collect(explode("\n", trim($response->streamedContent())))
            ->map(fn (string $line): array => json_decode($line, true, flags: JSON_THROW_ON_ERROR));

        $this->assertSame('preparing', $events->first()['phase']);
        $this->assertTrue($events->contains(fn (array $event): bool => ($event['type'] ?? null) === 'progress'
            && ($event['phase'] ?? null) === 'nodes'
            && ($event['current'] ?? null) === 0
            && ($event['total'] ?? null) === 7));
        $this->assertTrue($events->contains(fn (array $event): bool => ($event['type'] ?? null) === 'progress'
            && ($event['phase'] ?? null) === 'nodes'
            && ($event['current'] ?? null) === 7
            && ($event['total'] ?? null) === 7));
        $this->assertSame('complete', $events->last()['type']);
        $this->assertSame(7, $events->last()['result']['report']['Nodes written']);
    }

    public function test_invalid_export_does_not_create_a_workspace(): void
    {
        $uploadId = $this->upload('{not valid json');

        $this->postJson('/api/imports/roam/finish', [
            'upload_id' => $uploadId,
            'workspace_id' => null,
            'new_workspace_name' => 'Should Not Exist',
            'download_attachments' => false,
        ])
            ->assertUnprocessable()
            ->assertJsonPath('message', fn (string $message): bool => str_contains($message, 'not valid JSON'));

        $this->assertCount(1, $this->workspaces->all());
    }

    public function test_exports_larger_than_the_php_upload_limit_are_chunked(): void
    {
        $content = file_get_contents($this->fixture).str_repeat(' ', (2 * 1024 * 1024) + 1);
        $uploadId = $this->upload($content);

        $this->deleteJson("/api/imports/roam/{$uploadId}")
            ->assertNoContent();
    }

    private function upload(string $content): string
    {
        $size = strlen($content);
        $initialization = $this->postJson('/api/imports/roam/init', [
            'filename' => 'roam-export.json',
            'size' => $size,
        ])
            ->assertCreated()
            ->json();
        $uploadId = $initialization['upload_id'];
        $chunkSize = $initialization['chunk_size'];
        $totalChunks = $initialization['total_chunks'];

        for ($index = 0; $index < $totalChunks; $index++) {
            $chunk = substr($content, $index * $chunkSize, $chunkSize);

            $this->post('/api/imports/roam/chunk', [
                'upload_id' => $uploadId,
                // Multipart form fields arrive as strings in real browser requests.
                'chunk_index' => (string) $index,
                'chunk' => UploadedFile::fake()->createWithContent("chunk_{$index}", $chunk),
            ], ['Accept' => 'application/json'])
                ->assertSuccessful()
                ->assertJsonPath('received', $index);
        }

        return $uploadId;
    }

    private function deleteDirectory(string $directory): void
    {
        if (! is_dir($directory)) {
            return;
        }

        $entries = scandir($directory);

        if ($entries === false) {
            return;
        }

        foreach ($entries as $entry) {
            if ($entry === '.' || $entry === '..') {
                continue;
            }

            $path = $directory.DIRECTORY_SEPARATOR.$entry;

            if (is_dir($path)) {
                $this->deleteDirectory($path);
            } else {
                unlink($path);
            }
        }

        rmdir($directory);
    }
}
