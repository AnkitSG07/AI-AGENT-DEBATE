import { LiveKitWhatsAppProvider, readLiveKitConfig } from '../media/livekit-provider.mjs';
import { TransferController } from '../media/transfer-controller.mjs';
import { callStoreKey } from '../media/transfer-controller.mjs';
import { requireValue } from '../media/errors.mjs';
import { CallRuntime } from './call-runtime.mjs';
import { createNativeReadinessVerifier } from './readiness.mjs';
import { createBoundedNativeReject } from '../media/native-meta-reject.mjs';

/** Root owns the bearer authenticator, persistent registry and verified webhook.
 * Construction performs no network action. verifyConfiguration() is a read-only
 * control API check; it never proves audio or enables transfer by itself. */
export function createNativeCallRuntime({ store, env, authenticate, resolveDevice, listDevices,
  capabilities = async () => ({ roomCalling: false, transferEnabled: false }), roomCapabilities, rejectIncoming, notify, onWorkAvailable, onTiming, onRuntimeTiming,
  phoneNumberId, minimumNativeBuild = 10, tenantId = 'smart-handicrafts', now = Date.now,
  provider: injectedProvider } = {}) {
  const provider = injectedProvider || new LiveKitWhatsAppProvider(readLiveKitConfig(env), { onTiming });
  // Production native declines must not inherit the legacy browser adapter's
  // unbounded HTTP lifetime. Tests can still inject an isolated provider stub.
  const nativeReject = injectedProvider ? rejectIncoming : createBoundedNativeReject({
    metaToken: provider.config.metaToken, apiVersion: provider.config.apiVersion });
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
  const roomRelease = typeof roomCapabilities === 'function' ? async () => {
    const requested = await roomCapabilities();
    return { roomCalling: controlVerified && requested?.roomCalling === true };
  } : undefined;
  // Explicit, bounded pilot authority is separate from production evidence.
  // No fabricated live-test ID or request-supplied mode bypasses the guard.
  class RuntimeTransferController extends TransferController {
    get enforcesRuntimeCapabilities() { return true; }
    async requireRollout(context, args, actor) {
      const policy = await release();
      if (policy.mode !== 'pilot') return this.validateRollout(policy.transferEnabled ? policy.transferValidation : false);
      requireValue(policy.transferEnabled, 'TRANSFER_PILOT_NOT_ENABLED', 'The enrolled-device pilot has not been enabled.', 501);
      const call = await store.get(callStoreKey(args.callId));
      const transfer = call?.transfer?.id === args.transferId ? call.transfer : call?.transferHistory?.[args.transferId];
      const ids = new Set([actor.deviceId, call?.owner?.deviceId, args.toDeviceId, transfer?.fromDeviceId, transfer?.toDeviceId].filter(Boolean));
      requireValue(ids.size >= 2 && [...ids].every(id => policy.pilotDeviceIds.includes(id)),
        'DEVICE_NOT_IN_TRANSFER_PILOT', 'Both enrolled devices must be in the server-owned transfer pilot.', 403);
      await Promise.all([...ids].map(async id => {
        // actor was freshly authenticated by this operation, including generation,
        // expiry and supported native protocol. Other participants remain fresh
        // durable registry reads, performed independently rather than serially.
        const row = id === actor.deviceId ? actor : await resolveDevice(id);
        requireValue(row && !row.revoked && row.tenantId === tenantId && row.credentialExpiresAt > now() &&
          row.nativeBuild >= minimumNativeBuild && row.mediaProtocol === 'sh-room-audio-v1',
          'PILOT_DEVICE_UNAVAILABLE', 'A pilot device is not enrolled with the supported native build.', 403);
      }));
    }
  }
  const controller = new RuntimeTransferController({ store, provider, authenticate: context => runtime.actor(context),
    resolveDevice, now, rolloutGuard: async () => {
      const policy = await release();
      return policy.transferEnabled ? policy.transferValidation : false;
    }, verifyReadiness: data => runtime.verifyTransferReadiness(data) });
  runtime = new CallRuntime({ store, provider, transferController: controller, authenticate, resolveDevice, listDevices,
    capabilities: release, roomCapabilities: roomRelease, verifyReadiness, rejectIncoming: nativeReject, notify, onWorkAvailable, phoneNumberId, tenantId, minimumNativeBuild, now, onRuntimeTiming });
  return { runtime, provider, controller,
    verifyConfiguration: async () => {
      controlVerified = false;
      const probe = await provider.probeControlApi();
      controlVerified = probe.controlApiReachable === true && probe.fingerprint === provider.config.fingerprint;
      return { ...probe, roomCallingConfigured: controlVerified, audioVerified: false, transferEnabled: false };
    }, disableNewCalls: () => { controlVerified = false; } };
}
