<?php

namespace App\Http\Controllers;

use App\Models\Op;
use App\Models\Workspace;
use App\Sync\SyncService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class SyncController extends Controller
{
    public function __construct(
        private SyncService $sync,
    ) {}

    public function push(Request $request, Workspace $workspace): JsonResponse
    {
        $this->authorizeWorkspace($request, $workspace);

        $request->validate([
            'client_id' => ['required', 'string'],
            'ops' => ['required', 'array', 'max:1000'],
            'ops.*.op_id' => ['required', 'string', 'uuid'],
            'ops.*.client_id' => ['required', 'string'],
            'ops.*.hlc' => ['required', 'string', 'regex:/^\d{15}-[0-9a-f]{4}-.+$/'],
            'ops.*.type' => ['required', 'string', 'in:node.set,node.delete,node.purge,media.create'],
            'ops.*.payload' => ['required', 'array'],
            'ops.*.payload.id' => ['required', 'string', 'uuid'],
            'ops.*.payload.fields' => ['array'],
        ]);

        // Raw input, not the validated subset: validation keeps only keys
        // with explicit rules and would strip payload fields from the log
        $accepted = $this->sync->push(
            $workspace,
            $request->user(),
            $request->string('client_id')->toString(),
            $request->input('ops'),
        );

        return response()->json(['accepted' => $accepted]);
    }

    public function pull(Request $request, Workspace $workspace): JsonResponse
    {
        $this->authorizeWorkspace($request, $workspace);

        $request->validate([
            'since' => ['required', 'integer', 'min:0'],
        ]);

        return response()->json(
            $this->sync->pull($workspace, (int) $request->input('since')),
        );
    }

    public function bootstrap(Request $request, Workspace $workspace): JsonResponse
    {
        $this->authorizeWorkspace($request, $workspace);

        return response()->json(
            $this->sync->bootstrap($workspace),
        );
    }

    /**
     * Cheap probe for pairing: token validity plus the workspace's cursor
     * position, without shipping any data.
     */
    public function status(Request $request, Workspace $workspace): JsonResponse
    {
        $this->authorizeWorkspace($request, $workspace);

        return response()->json([
            'workspace_id' => $workspace->id,
            'user_id' => (string) $request->user()->getAuthIdentifier(),
            'latest_seq' => (int) Op::where('workspace_id', $workspace->id)->max('server_seq'),
            'realtime' => $this->realtimeConfig(),
        ]);
    }

    /**
     * Public connection settings only. The app secret remains server-side.
     *
     * @return array{
     *     enabled: bool,
     *     app_key: ?string,
     *     host: ?string,
     *     port: ?int,
     *     scheme: ?string
     * }
     */
    private function realtimeConfig(): array
    {
        $key = config('reverb.public.app_key');
        $host = config('reverb.public.host');
        $port = config('reverb.public.port');
        $scheme = config('reverb.public.scheme');
        $enabled = config('broadcasting.default') === 'reverb'
            && is_string($key) && $key !== ''
            && is_string($host) && $host !== ''
            && is_numeric($port)
            && in_array($scheme, ['http', 'https'], true);

        return [
            'enabled' => $enabled,
            'app_key' => $enabled ? $key : null,
            'host' => $enabled ? $host : null,
            'port' => $enabled ? (int) $port : null,
            'scheme' => $enabled ? $scheme : null,
        ];
    }

    private function authorizeWorkspace(Request $request, Workspace $workspace): void
    {
        abort_unless($workspace->user_id === $request->user()->id, 404);
    }
}
