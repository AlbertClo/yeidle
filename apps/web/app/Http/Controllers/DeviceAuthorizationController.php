<?php

namespace App\Http\Controllers;

use App\Events\DeviceAuthorizationApproved;
use App\Models\DeviceAuthorization;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Inertia\Inertia;
use Inertia\Response;

class DeviceAuthorizationController extends Controller
{
    public function show(DeviceAuthorization $deviceAuthorization): Response
    {
        return Inertia::render('DeviceAuthorization', [
            'authorization' => [
                'id' => $deviceAuthorization->id,
                'device_name' => $deviceAuthorization->device_name,
                'approved' => $deviceAuthorization->approved_at !== null,
                'expired' => $deviceAuthorization->expires_at->isPast(),
            ],
        ]);
    }

    public function approve(Request $request, DeviceAuthorization $deviceAuthorization): RedirectResponse
    {
        abort_if($deviceAuthorization->expires_at->isPast(), 410);

        if ($deviceAuthorization->approved_at === null) {
            $deviceAuthorization->user()->associate($request->user());
            $deviceAuthorization->approved_at = now();
            $deviceAuthorization->save();
            DeviceAuthorizationApproved::dispatch($deviceAuthorization->id);
        }

        return redirect()->route('device-authorizations.show', $deviceAuthorization);
    }
}
