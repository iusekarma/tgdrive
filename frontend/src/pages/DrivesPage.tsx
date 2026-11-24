import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, HardDrive, KeyRound, Lock, LockOpen, Network, Pencil, Plus, ShieldPlus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { api, type DriveInfo } from "../api";
import {
  CreateDriveDialog,
  DeleteDriveDialog,
  DrivePasswordDialog,
  RecoveryKeyDialog,
  RenameDriveDialog,
  UnlockDialog,
  WebDavDialog,
  type PasswordAction,
} from "../components/driveDialogs";
import LockDial from "../components/LockDial";
import { Menu, MenuDivider, MenuItem } from "../components/menu";
import { Page, Topbar } from "../components/shell";
import { Button, ErrorNote, useSavedView, ViewToggle } from "../components/ui";
import { useUploads } from "../components/uploads";
import { driveUrl } from "../format";
import { forgetThumbnails } from "../thumbs";

/** What another page, or the sidebar, came here for. */
type RouteState = { unlock?: string; from?: string; create?: boolean } | null;

type Open =
  | { type: "unlock"; drive: string; returnTo: string | null }
  | { type: "create" }
  | { type: "password"; drive: string; action: PasswordAction }
  | { type: "rename"; drive: string }
  | { type: "delete"; drive: DriveInfo }
  | { type: "recoveryKey"; drive: string; recoveryKey: string; open: boolean }
  | { type: "webdav"; drive: DriveInfo }
  | null;

function status(d: DriveInfo): string {
  return !d.protected ? "Opens with the master password" : d.unlocked ? "Unlocked" : "Locked with its own password";
}

function DriveIcon({ drive }: { drive: DriveInfo }) {
  if (drive.protected) return <LockDial unlocked={drive.unlocked} className="h-11 w-11" />;
  return (
    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-line bg-surface">
      <HardDrive size={19} className="text-ink/75" aria-hidden="true" />
    </span>
  );
}

function WebDavTag() {
  return (
    <span
      title="Can be mounted over WebDAV"
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-ink/6 px-2 py-0.5 text-xs text-muted"
    >
      <Network size={12} aria-hidden="true" />
      WebDAV
    </span>
  );
}

export default function DrivesPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const uploads = useUploads();
  const [view, changeView] = useSavedView("tgdrive.drivesView", "grid");
  const routeState = location.state as RouteState;

  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);

  // Arriving here from a drive whose session expired opens its unlock dialog straight away,
  // and the sidebar asks for one this way too, even from this page. The request is used once;
  // a reload should not reopen the dialog.
  useEffect(() => {
    if (!routeState) return;
    if (routeState.unlock) setOpen({ type: "unlock", drive: routeState.unlock, returnTo: routeState.from ?? null });
    else if (routeState.create) setOpen({ type: "create" });
    navigate("/", { replace: true, state: null });
  }, [routeState, navigate]);

  const drives = useQuery({ queryKey: ["drives"], queryFn: api.drives });
  const refreshDrives = () => queryClient.invalidateQueries({ queryKey: ["drives"] });

  async function lockDrive(name: string) {
    await api.lock(name).catch(() => undefined);
    queryClient.removeQueries({ queryKey: ["nodes", name] });
    forgetThumbnails(name);
    await refreshDrives();
  }

  function openDrive(d: DriveInfo) {
    if (d.unlocked) navigate(driveUrl(d.name));
    else setOpen({ type: "unlock", drive: d.name, returnTo: null });
  }

  function driveMenu(d: DriveInfo) {
    return (
      <Menu label={`More actions for ${d.name}`}>
        {(closeMenu) => {
          const pick = (next: Open) => () => {
            closeMenu();
            setOpen(next);
          };
          return (
            <>
              {d.protected && d.unlocked && (
                <MenuItem
                  onSelect={() => {
                    closeMenu();
                    void lockDrive(d.name);
                  }}
                >
                  <Lock size={16} />
                  Lock drive
                </MenuItem>
              )}
              {d.unlocked && (
                <MenuItem onSelect={pick({ type: "rename", drive: d.name })}>
                  <Pencil size={16} />
                  Rename drive
                </MenuItem>
              )}
              {d.protected ? (
                <>
                  <MenuItem onSelect={pick({ type: "password", drive: d.name, action: "change" })}>
                    <KeyRound size={16} />
                    Change password
                  </MenuItem>
                  <MenuItem onSelect={pick({ type: "password", drive: d.name, action: "remove" })}>
                    <LockOpen size={16} />
                    Remove password
                  </MenuItem>
                </>
              ) : (
                <MenuItem onSelect={pick({ type: "password", drive: d.name, action: "add" })}>
                  <ShieldPlus size={16} />
                  Add a password
                </MenuItem>
              )}
              <MenuItem onSelect={pick({ type: "webdav", drive: d })}>
                <Network size={16} />
                WebDAV access
              </MenuItem>
              <MenuDivider />
              <MenuItem danger onSelect={pick({ type: "delete", drive: d })}>
                <Trash2 size={16} />
                Delete drive
              </MenuItem>
            </>
          );
        }}
      </Menu>
    );
  }

  const list = drives.data ?? [];
  /** Covers its card or row, so anywhere on it opens the drive. */
  const cover = "outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:outline-2 focus-visible:after:outline-accent";

  return (
    <>
      <Page>
        {/* Only for the way to the sidebar; on wide screens it's there already. */}
        <div className="contents lg:hidden">
          <Topbar>
            <span className="px-1 text-[15px] font-semibold tracking-tight">tgdrive</span>
          </Topbar>
        </div>

        <main className="mx-auto w-full max-w-6xl shrink-0 px-4 pb-24 pt-6 @3xl:px-8 lg:pt-9">
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-2xl font-semibold tracking-tight">Drives</h1>
            <div className="flex shrink-0 items-center gap-2">
              <ViewToggle view={view} onChange={changeView} />
              <Button variant="primary" onClick={() => setOpen({ type: "create" })}>
                <Plus size={16} aria-hidden="true" />
                Create drive
              </Button>
            </div>
          </div>
          <p className="mt-1.5 max-w-3xl text-pretty text-sm leading-relaxed text-muted">
            Every drive is encrypted before it leaves this server, so Telegram only ever holds what it can't read.
          </p>

          <div className="mt-6">
            {drives.isPending && <p className="text-sm text-muted">Loading drives…</p>}
            {drives.error && <ErrorNote>{drives.error.message}</ErrorNote>}
            {drives.data?.length === 0 && (
              <div className="flex flex-col items-center rounded-2xl border border-dashed border-line px-6 py-16 text-center">
                <HardDrive size={28} className="text-muted" aria-hidden="true" />
                <p className="mt-4 text-sm font-medium">No drives yet</p>
                <p className="mb-5 mt-1 text-sm text-muted">Create one to start storing files.</p>
                <Button variant="primary" onClick={() => setOpen({ type: "create" })}>
                  Create drive
                </Button>
              </div>
            )}
            {list.length > 0 && view === "list" && (
              <ul className="divide-y divide-line border-y border-line">
                {list.map((d) => (
                  <li key={d.name} className="relative flex items-center gap-4 px-2 py-3.5 hover:bg-ink/3">
                    <DriveIcon drive={d} />
                    <span className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => openDrive(d)}
                        className={`block max-w-full truncate text-left text-[15px] font-medium ${cover}`}
                      >
                        {d.name}
                      </button>
                      <span className={`block truncate text-[13px] ${d.unlocked ? "text-muted" : "text-brass"}`}>{status(d)}</span>
                    </span>
                    {d.webdav && <WebDavTag />}
                    <span className="hidden text-[13px] text-muted @lg:block" aria-hidden="true">
                      {d.unlocked ? "Open" : "Unlock"}
                    </span>
                    <span className="relative z-[1]">{driveMenu(d)}</span>
                  </li>
                ))}
              </ul>
            )}
            {list.length > 0 && view === "grid" && (
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-3">
                {list.map((d) => (
                  <li
                    key={d.name}
                    className="group relative flex flex-col @lg:min-h-40 rounded-2xl border border-line p-4 transition-colors hover:border-ink/25 hover:bg-surface"
                  >
                    <span className="flex items-start justify-between">
                      <DriveIcon drive={d} />
                      <span className="relative z-[1] -mr-1.5 -mt-1.5">{driveMenu(d)}</span>
                    </span>
                    <span className="mt-auto block min-w-0 pt-4">
                      <button
                        type="button"
                        onClick={() => openDrive(d)}
                        className={`block max-w-full truncate text-left text-[15px] font-medium ${cover}`}
                      >
                        {d.name}
                      </button>
                      <span className="mt-0.5 flex h-5 items-center justify-between gap-2">
                        <span className={`truncate text-[13px] ${d.unlocked ? "text-muted" : "text-brass"}`}>{status(d)}</span>
                        {d.webdav ? (
                          <WebDavTag />
                        ) : (
                          <ChevronRight
                            size={16}
                            className="shrink-0 text-muted opacity-0 transition-opacity group-hover:opacity-100"
                            aria-hidden="true"
                          />
                        )}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </main>
      </Page>

      {open?.type === "unlock" && (
        <UnlockDialog
          drive={open.drive}
          onClose={close}
          onUnlocked={() => {
            const target = open.returnTo ?? driveUrl(open.drive);
            // Drop the "locked" answers cached for this drive, or the page we return to would bounce straight back.
            queryClient.removeQueries({ queryKey: ["nodes", open.drive] });
            void refreshDrives();
            navigate(target);
          }}
        />
      )}
      {open?.type === "create" && (
        <CreateDriveDialog
          onClose={close}
          onCreated={(name, recoveryKey) => {
            void refreshDrives();
            if (recoveryKey) setOpen({ type: "recoveryKey", drive: name, recoveryKey, open: true });
            else navigate(driveUrl(name));
          }}
        />
      )}
      {open?.type === "password" && (
        <DrivePasswordDialog
          drive={open.drive}
          action={open.action}
          onClose={close}
          onDone={(recoveryKey) => {
            void refreshDrives();
            if (recoveryKey) setOpen({ type: "recoveryKey", drive: open.drive, recoveryKey, open: false });
            else close();
          }}
        />
      )}
      {open?.type === "rename" && (
        <RenameDriveDialog
          drive={open.drive}
          onClose={close}
          onRenamed={(name) => {
            uploads.renameDrive(open.drive, name);
            queryClient.removeQueries({ queryKey: ["nodes", open.drive] });
            forgetThumbnails(open.drive);
            void refreshDrives();
            close();
          }}
        />
      )}
      {open?.type === "recoveryKey" && (
        <RecoveryKeyDialog
          title={`Save the recovery key for ${open.drive}`}
          recoveryKey={open.recoveryKey}
          action={open.open ? "Open drive" : "Done"}
          onDone={() => (open.open ? navigate(driveUrl(open.drive)) : close())}
        >
          If you forget this drive's password, this key is the only way back into it.
        </RecoveryKeyDialog>
      )}
      {open?.type === "delete" && (
        <DeleteDriveDialog
          drive={open.drive.name}
          isProtected={open.drive.protected}
          onClose={close}
          onDeleted={() => {
            queryClient.removeQueries({ queryKey: ["nodes", open.drive.name] });
            forgetThumbnails(open.drive.name);
            void refreshDrives();
            close();
          }}
        />
      )}
      {open?.type === "webdav" && (
        <WebDavDialog
          drive={open.drive.name}
          isProtected={open.drive.protected}
          onClose={close}
          onChanged={() => void refreshDrives()}
        />
      )}
    </>
  );
}
