import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive, KeyRound, Lock, LockOpen, Plus, ShieldPlus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { api, type DriveInfo } from "../api";
import {
  CreateDriveDialog,
  DeleteDriveDialog,
  DrivePasswordDialog,
  MasterPasswordDialog,
  RecoveryKeyDialog,
  UnlockDialog,
  type PasswordAction,
} from "../components/driveDialogs";
import LockDial from "../components/LockDial";
import { Button, ErrorNote, ICON_BUTTON, Menu, MenuItem, PageHeader } from "../components/ui";
import { useLockEverything } from "../components/VaultGate";
import { driveUrl } from "../format";
import { forgetThumbnails } from "../thumbs";

type RouteState = { unlock?: string; from?: string } | null;

type Open =
  | { type: "unlock"; drive: string; returnTo: string | null }
  | { type: "create" }
  | { type: "password"; drive: string; action: PasswordAction }
  | { type: "delete"; drive: DriveInfo }
  | { type: "recoveryKey"; drive: string; recoveryKey: string; open: boolean }
  | { type: "masterPassword" }
  | null;

function DriveIcon({ drive }: { drive: DriveInfo }) {
  if (drive.protected) return <LockDial unlocked={drive.unlocked} />;
  return (
    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-line bg-surface">
      <HardDrive size={22} className="text-teal" aria-hidden="true" />
    </span>
  );
}

export default function DrivesPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const lockEverything = useLockEverything();
  const routeState = location.state as RouteState;

  // Arriving here from a drive whose session expired opens its unlock dialog straight away.
  const [open, setOpen] = useState<Open>(
    routeState?.unlock ? { type: "unlock", drive: routeState.unlock, returnTo: routeState.from ?? null } : null,
  );
  const close = () => setOpen(null);

  // The request to unlock is used once; a reload should not reopen the dialog.
  useEffect(() => {
    if (routeState) navigate("/", { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  return (
    <>
      <PageHeader>
        <Button onClick={() => void lockEverything()}>
          <Lock size={16} />
          Lock
        </Button>
        <Menu label="Settings">
          {(closeMenu) => (
            <MenuItem
              onSelect={() => {
                closeMenu();
                setOpen({ type: "masterPassword" });
              }}
            >
              <KeyRound size={16} />
              Change master password
            </MenuItem>
          )}
        </Menu>
      </PageHeader>

      <main className="mx-auto max-w-4xl px-5 pb-24 pt-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Drives</h1>
            <p className="mt-3 max-w-prose text-muted">
              Every drive is encrypted, and the files live in your Telegram channel, where they are unreadable without
              your keys. A drive can also have its own password.
            </p>
          </div>
          <Button variant="primary" onClick={() => setOpen({ type: "create" })}>
            <Plus size={16} />
            Create drive
          </Button>
        </div>

        <div className="mt-10">
          {drives.isPending && <p className="text-muted">Loading drives…</p>}
          {drives.error && <ErrorNote>{drives.error.message}</ErrorNote>}
          {drives.data?.length === 0 && (
            <p className="border-y border-line py-10 text-muted">No drives yet. Create one to start storing files.</p>
          )}
          {drives.data && drives.data.length > 0 && (
            <ul className="divide-y divide-line border-y border-line">
              {drives.data.map((d) => (
                <li key={d.name} className="flex items-center gap-1 pr-1 hover:bg-ink/[0.03]">
                  <button
                    type="button"
                    onClick={() => openDrive(d)}
                    className="flex min-w-0 flex-1 items-center gap-5 px-1 py-5 text-left"
                  >
                    <DriveIcon drive={d} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-2xl font-semibold tracking-tight">{d.name}</span>
                      <span className="block text-sm text-muted">
                        {!d.protected ? "Opens with the master password" : d.unlocked ? "Unlocked" : "Locked"}
                      </span>
                    </span>
                    <span className="text-sm font-medium text-teal">{d.unlocked ? "Open" : "Unlock"}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setOpen({ type: "delete", drive: d })}
                    aria-label={`Delete ${d.name}`}
                    title="Delete drive"
                    className={`${ICON_BUTTON} hover:text-danger`}
                  >
                    <Trash2 size={18} />
                  </button>
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
                          <MenuItem danger onSelect={pick({ type: "delete", drive: d })}>
                            <Trash2 size={16} />
                            Delete drive
                          </MenuItem>
                        </>
                      );
                    }}
                  </Menu>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>

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
      {open?.type === "masterPassword" && <MasterPasswordDialog onClose={close} />}
    </>
  );
}
