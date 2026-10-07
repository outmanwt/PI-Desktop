import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ExternalMemoryCandidate,
  ExternalMemoryImportPayload,
  ExternalMemoryScanResult,
} from "../../../lib/api";
import { api } from "../../../lib/api";
import { useAppStore } from "../../../stores/app-store";
import { Badge } from "../../../components/ui";
import {
  ImportIdle,
  ImportResults,
  ImportRow,
  ImportToolbar,
  toggleKey,
} from "../import-workbench";
import { formatImportDate } from "../../../lib/import-groups";

export function MemoryScanImportPanel({
  projectPath,
  onImported,
}: {
  projectPath?: string | null;
  onImported?: () => Promise<unknown> | void;
} = {}) {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const activeWorkspacePath = useAppStore((s) => s.workspace?.path ?? null);
  const targetPath = projectPath ?? activeWorkspacePath;
  const [result, setResult] = useState<ExternalMemoryScanResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);

  const keyOf = (candidate: ExternalMemoryCandidate) =>
    `${candidate.source}:${candidate.sourcePath}`;

  const scan = async () => {
    setScanning(true);
    try {
      const next = await api.scanExternalMemory();
      setResult(next);
      setSelected(new Set());
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setScanning(false);
    }
  };

  const runImport = async () => {
    if (!result || !targetPath) return;
    const items: ExternalMemoryImportPayload["items"] = result.candidates
      .filter((candidate) => selected.has(keyOf(candidate)))
      .map(({ source, sourcePath, id, title, content }) => ({
        source,
        sourcePath,
        id,
        title,
        content,
      }));
    if (items.length === 0) return;
    setImporting(true);
    try {
      const imported = await api.runExternalMemoryImport({
        projectPath: targetPath,
        items,
      });
      showToast(
        t("settings.importMemoryResult", {
          imported: imported.imported.length,
          skipped: imported.skipped.length,
          failed: imported.failed.length,
        }),
        { variant: imported.failed.length > 0 ? "error" : "success" },
      );
      if (onImported) {
        await onImported();
      }
      await scan();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), {
        variant: "error",
      });
    } finally {
      setImporting(false);
    }
  };

  const allKeys = result?.candidates.map(keyOf) ?? [];
  const allSelected =
    allKeys.length > 0 && allKeys.every((key) => selected.has(key));

  return (
    <div className="import-workbench">
      {result === null ? (
        <ImportIdle
          description={t("settings.importMemoryDesc")}
          note={
            targetPath
              ? t("settings.importMemoryTarget", { path: targetPath })
              : t("settings.selectProjectFirst")
          }
          onScan={() => void scan()}
          scanning={scanning}
        />
      ) : (
        <>
          <ImportToolbar
            found={t("settings.importMemoryFound", {
              count: result.candidates.length,
            })}
            selectedCount={selected.size}
            allSelected={allSelected}
            selectAllLabel={t("settings.importSelectAll")}
            onToggleAll={(on) => setSelected(on ? new Set(allKeys) : new Set())}
            scanning={scanning}
            importing={importing}
            onScan={() => void scan()}
            onImport={() => void runImport()}
          />
          <ImportResults
            message={
              result.candidates.length === 0
                ? t("settings.importAgentScanNone")
                : !targetPath
                  ? t("settings.selectProjectFirst")
                  : undefined
            }
          >
            <div className="import-groups">
              {result.candidates.map((candidate) => {
                const key = keyOf(candidate);
                return (
                  <ImportRow
                    key={key}
                    title={candidate.title}
                    meta={`${candidate.sourcePath} · ${formatImportDate(candidate.updatedAt)}`}
                    checked={selected.has(key)}
                    onChange={(on) =>
                      setSelected((previous) => toggleKey(previous, key, on))
                    }
                    badge={
                      <Badge tone="neutral">
                        {t("settings.importMemorySourceWorkBuddy")}
                      </Badge>
                    }
                  />
                );
              })}
            </div>
          </ImportResults>
        </>
      )}
    </div>
  );
}
