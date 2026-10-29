import { LiveKitWhatsAppProvider, readLiveKitConfig } from '../media/livekit-provider.mjs';
import { TransferController } from '../media/transfer-controller.mjs';
import { callStoreKey } from '../media/transfer-controller.mjs';
import { requireValue } from '../media/errors.mjs';
import { CallRuntime } from './call-runtime.mjs';
import { createNativeReadinessVerifier } from './readiness.mjs';

/** Root owns the bearer authenticator, persistent registry and verified webhook.
 * Construction performs no network action. verifyConfiguration() is a read-only
 * control API check; it never proves audio or enables transfer by itself. */
export function createNativeCallRuntime({ store, env, authenticate, resolveDevice, listDevices,
  capabilities = async () => ({ roomCalling: false, transferEnabled: false }), rejectIncoming, notify,
  phoneNumberId, minimumNativeBuild = 10, tenantId = 'smart-handicrafts', now = Date.now,
  provider: injectedProvider } = {}) {
  const provider = injectedProvider || new LiveKitWhatsAppProvider(readLiveKitConfig(env));
  const verifyReadiness = createNativeReadinessVerifier({ provider, now });
  let controlVerified = false, runtime;
  const release = async () => {
    const requested = await capabilities();
    const validation = requested?.transferValidation;
    const transferValidated = requested?.mode === 'production' && validation?.enabled === true && validation.provider === provider.kind &&
      validation.providerFingerprint === provider.config.fingerprint && validation.clientProtocol === 'sh-room-audio-v1' &&
      validation.nativeBuild >= minimumNativeBuild && typeof validation.liveTwoDeviceEvidenceId === 'string' &&
      validation.liveTwoDeviceEvidenceId.length >= 8;
    const pilotIds = Array.isArray(requested?.pilotDeviceIds) ? [...new Set(requested.pilotDeviceIds)] : [];
    const pilotAllowed = requested?.mode === 'pilot' && requested?.pilotEnabled === true && pilotIds.length >= 2 && pilotIds.length <= 4 &&
      pilotIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 220);
    return { ...requested, pilotDeviceIds: pilotIds, roomCalling: controlVerified && requested?.roomCalling === true,
      transferEnabled: controlVerified && requested?.roomCalling === true && requested?.transferEnabled === true && (transferValidated || pilotAllowed),
      reason: !controlVerified ? 'Media control configuration has not passed its read-only startup check.' : requested?.reason || '' };
  };
  // Explicit, bounded pilot authority is separate from production evidence.
  // No fabricated live-test ID or request-supplied mode bypasses the guard.
  class RuntimeTransferController extends TransferController {
    async requireRollout() {
      const policy = await release();
      if (policy.mode === 'pilot') {
        requireValue(policy.transferEnabled, 'TRANSFER_PILOT_NOT_ENABLED', 'The enrolled-device pilot has not been enabled.', 501);
        return;
      }
      return super.requireRollout();
    }
    async checkPilot(context, args) {
      const policy = await release();
      if (policy.mode !== 'pilot') return;
      requireValue(policy.transferEnabled, 'TRANSFER_PILOT_NOT_ENABLED', 'The enrolled-device pilot has not been enabled.', 501);
      const actor = await runtime.actor(context), call = await store.get(callStoreKey(args.callId));
      const transfer = call?.transfer?.id === args.transferId ? call.transfer : call?.transferHistory?.[args.transferId];
      const ids = new Set([actor.deviceId, call?.owner?.deviceId, args.toDeviceId, transfer?.fromDeviceId, transfer?.toDeviceId].filter(Boolean));
      requireValue(ids.size >= 2 && [...ids].every(id => policy.pilotDeviceIds.includes(id)),
        'DEVICE_NOT_IN_TRANSFER_PILOT', 'Both enrolled devices must be in the server-owned transfer pilot.', 403);
      for (const id of ids) {
        const row = await resolveDevice(id);
        requireValue(row && !row.revoked && row.tenantId === tenantId && row.credentialExpiresAt > now() &&
          row.nativeBuild >= minimumNativeBuild && row.mediaProtocol === 'sh-room-audio-v1',
          'PILOT_DEVICE_UNAVAILABLE', 'A pilot device is not enrolled with the supported native build.', 403);
      }
    }
    async invite(context, args) { await this.checkPilot(context, args); return super.invite(context, args); }
    async accept(context, args) { await this.checkPilot(context, args); return super.accept(context, args); }
    async confirmReady(context, args) { await this.checkPilot(context, args); return super.confirmReady(context, args); }
  }
  const controller = new RuntimeTransferController({ store, provider, authenticate: context => runtime.actor(context),
    resolveDevice, now, rolloutGuard: async () => {
      const policy = await release();
      return policy.transferEnabled ? policy.transferValidation : false;
    }, verifyReadiness: data => runtime.verifyTransferReadiness(data) });
  runtime = new CallRuntime({ store, provider, transferController: controller, authenticate, resolveDevice, listDevices,
    capabilities: release, verifyReadiness, rejectIncoming, notify, phoneNumberId, tenantId, minimumNativeBuild, now });
  return { runtime, provider, controller,
    verifyConfiguration: async () => {
      controlVerified = false;
      const probe = await provider.probeControlApi();
      controlVerified = probe.controlApiReachable === true && probe.fingerprint === provider.config.fingerprint;
      return { ...probe, roomCallingConfigured: controlVerified, audioVerified: false, transferEnabled: false };
    }, disableNewCalls: () => { controlVerified = false; } };
}
