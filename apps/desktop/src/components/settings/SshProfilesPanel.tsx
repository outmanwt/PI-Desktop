import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteHostSshProfile } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../ui";

export function SshProfilesPanel({ onConnected }: { onConnected: () => Promise<void> }) {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const [profiles, setProfiles] = useState<RemoteHostSshProfile[]>([]);
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const result = await api.scanRemoteHostSshProfiles();
      setProfiles(result.profiles);
    } catch {
      setProfiles([]);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    void scan();
  }, [scan]);

  const connect = useCallback(
    async (profile: RemoteHostSshProfile) => {
      setConnecting(profile.alias);
      try {
        const result = await api.bootstrapRemoteHost({
          label: profile.alias,
          // Keep the alias so OpenSSH applies the user's Host, User, ProxyJump,
          // IdentityAgent and other local configuration exactly as configured.
          host: profile.alias,
        });
        showToast(
          t("settings.remoteHosts.sshSucceeded", {
            label: result.host.label,
            defaultValue: "Connected to {{label}}",
          }),
          { variant: "info" },
        );
        await onConnected();
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        showToast(
          t("settings.remoteHosts.sshFailed", {
            message,
            defaultValue: "SSH connection failed: {{message}}",
          }),
          { variant: "error" },
        );
      } finally {
        setConnecting(null);
      }
    },
    [onConnected, showToast, t],
  );

  return (
    <section className="settings-card-block settings-remote-ssh-scan" aria-busy={scanning || connecting !== null}>
      <div className="settings-card-heading-row">
        <h3 className="settings-card-heading">
          {t("settings.remoteHosts.sshProfiles", { defaultValue: "SSH config" })}
        </h3>
        <Button type="button" variant="ghost" disabled={scanning} onClick={() => void scan()}>
          {scanning
            ? t("settings.remoteHosts.scanningSsh", { defaultValue: "Scanning…" })
            : t("settings.remoteHosts.scanSsh", { defaultValue: "Scan SSH config" })}
        </Button>
      </div>
      {profiles.length > 0 ? (
        <div className="settings-remote-ssh-profiles" role="list">
          {profiles.map((profile) => (
            <div className="settings-remote-ssh-profile" key={profile.alias} role="listitem">
              <div className="settings-remote-ssh-profile-copy">
                <strong>{profile.alias}</strong>
                <span>
                  {profile.user ? `${profile.user}@` : ""}
                  {profile.host}
                  {profile.port ? `:${profile.port}` : ""}
                </span>
                {profile.identityFile ? <small>{profile.identityFile.split(/[\\/]/).at(-1)}</small> : null}
              </div>
              <Button
                type="button"
                variant="primary"
                disabled={scanning || connecting !== null}
                onClick={() => void connect(profile)}
              >
                {connecting === profile.alias
                  ? t("settings.remoteHosts.sshRunning", { defaultValue: "Connecting…" })
                  : t("settings.remoteHosts.sshConnect", { defaultValue: "Install & connect" })}
              </Button>
            </div>
          ))}
        </div>
      ) : (
        <div className="settings-remote-host-empty" role="status">
          {scanning
            ? t("settings.remoteHosts.scanningSsh", { defaultValue: "Scanning…" })
            : t("settings.remoteHosts.noSshProfiles", { defaultValue: "No SSH host aliases found." })}
        </div>
      )}
    </section>
  );
}
