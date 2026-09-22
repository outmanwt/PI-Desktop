import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteHostSshProfile } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../ui";
import { IconKey, IconRefresh, IconServer, IconTerminal } from "../icons";

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
        <div className="settings-remote-ssh-heading-left">
          <h3 className="settings-card-heading">
            {t("settings.remoteHosts.sshProfiles", { defaultValue: "SSH config" })}
          </h3>
          {profiles.length > 0 ? (
            <span className="plugins-group-count">{profiles.length}</span>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={scanning}
          onClick={() => void scan()}
          className="settings-remote-ssh-scan-btn"
        >
          <IconRefresh size={13} className={scanning ? "settings-remote-ssh-spinning" : undefined} />
          <span>
            {scanning
              ? t("settings.remoteHosts.scanningSsh", { defaultValue: "Scanning…" })
              : t("settings.remoteHosts.scanSsh", { defaultValue: "Scan SSH config" })}
          </span>
        </Button>
      </div>
      {profiles.length > 0 ? (
        <div className="plugins-list settings-remote-ssh-profiles" role="list">
          {profiles.map((profile) => {
            const isConnecting = connecting === profile.alias;
            const keyName = profile.identityFile?.split(/[\\/]/).at(-1);
            return (
              <div
                className="plugins-row settings-remote-ssh-profile"
                key={profile.alias}
                role="listitem"
              >
                <span className="plugins-glyph" aria-hidden>
                  <IconServer size={15} />
                </span>
                <div className="plugins-row-copy settings-remote-ssh-profile-copy">
                  <div className="plugins-row-title">
                    <span className="plugins-row-name">{profile.alias}</span>
                    {profile.port && profile.port !== 22 ? (
                      <span className="plugins-tag">:{profile.port}</span>
                    ) : null}
                  </div>
                  <div className="plugins-row-meta">
                    <span className="plugins-row-id">
                      {profile.user ? `${profile.user}@` : ""}
                      {profile.host}
                    </span>
                    {keyName ? (
                      <>
                        <span className="plugins-dot" aria-hidden>
                          ·
                        </span>
                        <span className="settings-remote-ssh-key" title={profile.identityFile}>
                          <IconKey size={12} />
                          <span>{keyName}</span>
                        </span>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="plugins-row-controls">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={scanning || connecting !== null}
                    onClick={() => void connect(profile)}
                  >
                    {isConnecting ? (
                      <>
                        <IconRefresh size={13} className="settings-remote-ssh-spinning" />
                        <span>{t("settings.remoteHosts.sshRunning", { defaultValue: "Connecting…" })}</span>
                      </>
                    ) : (
                      <>
                        <IconTerminal size={13} />
                        <span>{t("settings.remoteHosts.sshConnect", { defaultValue: "Install & connect" })}</span>
                      </>
                    )}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="settings-remote-host-empty" role="status">
          <span className="plugins-glyph" aria-hidden>
            <IconServer size={15} />
          </span>
          <span>
            {scanning
              ? t("settings.remoteHosts.scanningSsh", { defaultValue: "Scanning…" })
              : t("settings.remoteHosts.noSshProfiles", { defaultValue: "No SSH host aliases found." })}
          </span>
        </div>
      )}
    </section>
  );
}
