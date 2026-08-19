import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ITEM_DRAG_TYPE, encodeDragPayload, decodeDragPayload } from "../../lib/dragTypes.js";
import { Thumbnail } from "./Thumbnail.js";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Clock,
  Download,
  Eye,
  Folder,
  FolderDown,
  GripVertical,
  LayoutGrid,
  List,
  MoreVertical,
  Pencil,
  Play,
  Search,
  Share2,
  Trash2,
} from "lucide-react";

export interface FileItem {
  id: string;
  name: string;
  mimeType: string;
  size: string;
  chunkSize: number;
  chunkCount: number;
  thumbnailBlobId?: string | null;
  status: string;
  createdAt: string;
  expiresAt?: string | null;
}

export interface FolderItem {
  id: string;
  name: string;
  subfolderCount: number;
  fileCount: number;
  totalSizeBytes?: string;
}

const DRAG_TYPE = ITEM_DRAG_TYPE;
const encodeDrag = encodeDragPayload;
const decodeDrag = decodeDragPayload;

interface Props {
  files: FileItem[];
  folders: FolderItem[];
  onDownload: (file: FileItem) => void;
  onPreview?: (file: FileItem) => void;
  onPlay?: (file: FileItem) => void;
  onDelete?: (file: FileItem) => void;
  onShare?: (file: FileItem) => void;
  onDownloadFolder?: (folder: FolderItem) => void;
  onRenameFolder?: (folder: FolderItem) => void;
  onDeleteFolder?: (folder: FolderItem) => void;
  onMoveFile?: (fileId: string, targetFolderId: string) => void;
  onMoveFolder?: (folderId: string, targetFolderId: string) => void;
  onExtendTtl?: (file: FileItem) => void;
  anonSessionId?: string;
  onOpenFolder?: (folderId: string) => void;
  onShareFolder?: (folder: FolderItem) => void;
}

type SortKey = "name" | "size" | "date";
type SortDir = "asc" | "desc";
type ViewMode = "list" | "grid";

const PAGE_SIZE = 20;
const VIEW_MODE_STORAGE_KEY = "ddv4-view-mode";

function loadViewMode(): ViewMode {
  try {
    const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return stored === "grid" ? "grid" : "list";
  } catch {
    return "list";
  }
}

export function FileTable({
  files, folders, onDownload, onPreview, onPlay, onDelete, onShare,
  onDownloadFolder, onRenameFolder, onDeleteFolder,
  onMoveFile, onMoveFolder, onExtendTtl, anonSessionId, onOpenFolder, onShareFolder,
}: Props) {
  const navigate = useNavigate();
  const openFolder = onOpenFolder ?? ((id: string) => navigate(`/folder/${id}`));
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "date", dir: "desc" });
  const [page, setPage] = useState(1);
  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode);
  const [draggingOver, setDraggingOver] = useState<string | null>(null);
  // Counter per folder to handle nested enter/leave events
  const dragCounters = useRef<Record<string, number>>({});

  const setViewModePersisted = (mode: ViewMode) => {
    setViewMode(mode);
    try { localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode); } catch { /* ignore */ }
  };


  const handleSort = (key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
    setPage(1);
  };

  const filtered = useMemo(() => files.filter((f) => f.name.toLowerCase().includes(query.toLowerCase())), [files, query]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      let cmp = 0;
      if (sort.key === "name") cmp = a.name.localeCompare(b.name);
      else if (sort.key === "size") cmp = Number(a.size) - Number(b.size);
      else cmp = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const paginated = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const isEmpty = folders.length === 0 && files.length === 0;
  const isFilteredEmpty = query.length > 0 && folders.length === 0 && paginated.length === 0;

  // Folder drag-over handlers — shared by both table rows and mobile cards
  const folderDragHandlers = (folderId: string, draggingId?: string) => ({
    onDragOver: (e: React.DragEvent) => {
      // Only accept internal item drags
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    },
    onDragEnter: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      dragCounters.current[folderId] = (dragCounters.current[folderId] ?? 0) + 1;
      if (draggingId !== folderId) setDraggingOver(folderId);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      dragCounters.current[folderId] = (dragCounters.current[folderId] ?? 1) - 1;
      if ((dragCounters.current[folderId] ?? 0) <= 0) {
        dragCounters.current[folderId] = 0;
        setDraggingOver((prev) => (prev === folderId ? null : prev));
      }
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      dragCounters.current[folderId] = 0;
      setDraggingOver(null);
      const payload = decodeDrag(e);
      if (!payload) return;
      if (payload.id === folderId) return; // can't drop onto itself
      if (payload.type === "file") onMoveFile?.(payload.id, folderId);
      else if (payload.type === "folder") onMoveFolder?.(payload.id, folderId);
    },
  });

  const isOver = (id: string) => draggingOver === id;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="text"
            placeholder="Search files…"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setPage(1); }}
            className="h-11 w-full rounded-md border border-rule-2 bg-paper py-3 pl-10 pr-4 text-sm text-ink outline-2 outline-offset-1 outline-transparent transition-colors duration-short ease-out placeholder:text-muted hover:bg-paper-2 focus:bg-paper focus:outline-focus"
          />
        </div>
        <div className="hidden shrink-0 overflow-hidden rounded-md border border-rule-2 md:flex">
          <button
            onClick={() => setViewModePersisted("list")}
            title="List view"
            aria-pressed={viewMode === "list"}
            className={`flex h-11 w-11 items-center justify-center transition-colors duration-short ease-out ${viewMode === "list" ? "bg-paper-3 text-ink" : "text-muted hover:bg-paper-2 hover:text-ink"}`}
          >
            <List size={16} />
          </button>
          <button
            onClick={() => setViewModePersisted("grid")}
            title="Grid view"
            aria-pressed={viewMode === "grid"}
            className={`flex h-11 w-11 items-center justify-center transition-colors duration-short ease-out ${viewMode === "grid" ? "bg-paper-3 text-ink" : "text-muted hover:bg-paper-2 hover:text-ink"}`}
          >
            <LayoutGrid size={16} />
          </button>
        </div>
      </div>

      {/* Mobile layout — always card list regardless of viewMode */}
      <div className="space-y-3 md:hidden">
        {isEmpty && <EmptyState />}
        {isFilteredEmpty && <FilteredEmptyState />}
        {folders.map((folder) => (
          <FolderCard
            key={`folder-${folder.id}`}
            folder={folder}
            isOver={isOver(folder.id)}
            dragHandlers={folderDragHandlers(folder.id)}
            onOpen={() => openFolder(folder.id)}
            onDownload={onDownloadFolder ? () => onDownloadFolder(folder) : undefined}
            onRename={onRenameFolder ? () => onRenameFolder(folder) : undefined}
            onDelete={onDeleteFolder ? () => onDeleteFolder(folder) : undefined}
            onShare={onShareFolder ? () => onShareFolder(folder) : undefined}
          />
        ))}
        {paginated.map((file) => (
          <FileCard
            key={file.id}
            file={file}
            onDownload={() => onDownload(file)}
            onPlay={onPlay && file.status === "READY" && file.mimeType.startsWith("video/") ? () => onPlay(file) : undefined}
            onShare={onShare && file.status === "READY" ? () => onShare(file) : undefined}
            onDelete={onDelete ? () => { if (confirm(`Delete "${file.name}"?`)) onDelete(file); } : undefined}
          />
        ))}
      </div>

      {/* Desktop grid view */}
      {viewMode === "grid" && (
        <div className="hidden md:block">
          {isEmpty && <EmptyState />}
          {isFilteredEmpty && <FilteredEmptyState />}
          {(folders.length > 0 || paginated.length > 0) && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {folders.map((folder) => (
                <div
                  key={`folder-grid-${folder.id}`}
                  onClick={() => openFolder(folder.id)}
                  {...folderDragHandlers(folder.id)}
                  className={`group relative flex cursor-pointer flex-col items-center gap-2 rounded-card border p-4 text-center transition-colors duration-short ease-out ${isOver(folder.id) ? "border-accent/60 bg-accent/10" : "border-rule bg-paper hover:border-rule-2 hover:bg-paper-2"}`}
                >
                  <Folder size={32} className={isOver(folder.id) ? "text-accent" : "text-muted"} />
                  <span className="w-full truncate text-sm text-ink">{folder.name}</span>
                  <span className="font-mono text-xs tabular-nums text-muted">{folder.fileCount} items</span>
                  {onShareFolder && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onShareFolder(folder); }}
                      title="Share"
                      className="absolute right-1.5 top-1.5 rounded-md p-1.5 text-muted opacity-0 transition-opacity duration-short ease-out hover:bg-paper-2 hover:text-ink group-hover:opacity-100"
                    >
                      <Share2 size={15} />
                    </button>
                  )}
                </div>
              ))}
              {paginated.map((file) => (
                <div
                  key={`file-grid-${file.id}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, encodeDrag({ type: "file", id: file.id }));
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  className="group flex flex-col overflow-hidden rounded-card border border-rule bg-paper transition-colors duration-short ease-out hover:border-rule-2"
                >
                  <div className="relative aspect-square w-full overflow-hidden bg-paper-2">
                    <Thumbnail fileId={file.id} thumbnailBlobId={file.thumbnailBlobId} mimeType={file.mimeType} anonSessionId={anonSessionId} />
                    <div className="absolute right-1.5 top-1.5 opacity-0 transition-opacity duration-short ease-out group-hover:opacity-100">
                      <FileActionMenu fileName={file.name} onDownload={() => onDownload(file)} onPlay={onPlay && file.status === "READY" && file.mimeType.startsWith("video/") ? () => onPlay(file) : undefined} onShare={onShare && file.status === "READY" ? () => onShare(file) : undefined} onDelete={onDelete ? () => { if (confirm(`Delete "${file.name}"?`)) onDelete(file); } : undefined} />
                    </div>
                  </div>
                  <div className="p-2.5">
                    <p className="truncate text-xs font-medium text-ink" title={file.name}>{file.name}</p>
                    <p className="mt-0.5 font-mono text-[11px] tabular-nums text-muted">{formatSize(file.size)}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Desktop table (list view) */}
      <div className={`hidden overflow-hidden rounded-card border border-rule bg-paper ${viewMode === "list" ? "md:block" : ""}`}>
        <table className="w-full">
          <thead>
            <tr className="border-b border-rule">
              <th className="w-8" />
              <th className="w-12" />
              <SortHeader label="Name" sortKey="name" current={sort} onSort={handleSort} />
              <SortHeader label="Size" sortKey="size" current={sort} onSort={handleSort} />
              <SortHeader label="Date" sortKey="date" current={sort} onSort={handleSort} />
              <th className="w-32" />
            </tr>
          </thead>
          <tbody>
            {isEmpty && (
              <tr><td colSpan={6} className="px-4 py-16 text-center text-sm text-muted"><EmptyCopy /></td></tr>
            )}

            {folders.map((folder) => (
              <tr
                key={`folder-${folder.id}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_TYPE, encodeDrag({ type: "folder", id: folder.id }));
                  e.dataTransfer.effectAllowed = "move";
                }}
                className={`border-b transition-colors duration-short ease-out ${isOver(folder.id) ? "border-accent/50 bg-accent/10 ring-1 ring-inset ring-accent/40" : "border-rule hover:bg-paper-2"}`}
                {...folderDragHandlers(folder.id, folder.id)}
              >
                <td className="px-2 py-3 text-muted">
                  <GripVertical size={14} />
                </td>
                <td className="px-2 py-3">
                  <Folder size={18} className={isOver(folder.id) ? "text-accent" : "text-muted"} />
                </td>
                <td className="cursor-pointer px-4 py-3 text-ink" onClick={() => openFolder(folder.id)}>
                  <span className="inline-flex items-center gap-2">
                    {folder.name}
                    {isOver(folder.id) && <span className="ml-1 text-xs text-accent">Drop here</span>}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-muted">
                  <span className="font-mono tabular-nums">
                    {folder.fileCount} items{folder.totalSizeBytes ? ` · ${formatSize(folder.totalSizeBytes)}` : ""}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-muted">—</td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    {onDownloadFolder && <IconButton onClick={() => onDownloadFolder(folder)} title="Download as ZIP" className="text-accent hover:bg-accent/10"><FolderDown size={15} /></IconButton>}
                    {onRenameFolder && <IconButton onClick={() => onRenameFolder(folder)} title="Rename" className="text-muted hover:bg-paper-2 hover:text-ink"><Pencil size={15} /></IconButton>}
                    {onShareFolder && <IconButton onClick={() => onShareFolder(folder)} title="Share" className="text-muted hover:bg-paper-2 hover:text-ink"><Share2 size={15} /></IconButton>}
                    {onDeleteFolder && <IconButton onClick={() => onDeleteFolder(folder)} title="Delete" className="text-error hover:bg-error/10 hover:text-error"><Trash2 size={15} /></IconButton>}
                  </div>
                </td>
              </tr>
            ))}

            {paginated.length === 0 && !isEmpty && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-muted">No files match your search</td></tr>
            )}

            {paginated.map((file) => (
              <tr
                key={file.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_TYPE, encodeDrag({ type: "file", id: file.id }));
                  e.dataTransfer.effectAllowed = "move";
                }}
                className="border-b border-rule transition-colors duration-short ease-out hover:bg-paper-2"
              >
                <td className="px-2 py-3 text-muted cursor-grab active:cursor-grabbing">
                  <GripVertical size={14} />
                </td>
                <td className="px-2 py-3">
                  <div className="h-9 w-9 overflow-hidden rounded-md bg-paper-2">
                    <Thumbnail fileId={file.id} thumbnailBlobId={file.thumbnailBlobId} mimeType={file.mimeType} className="h-full w-full object-cover" anonSessionId={anonSessionId} />
                  </div>
                </td>
                <td className="px-4 py-3 text-ink">{file.name}</td>
                <td className="px-4 py-3 text-sm text-muted"><span className="font-mono tabular-nums">{formatSize(file.size)}</span></td>
                <td className="px-4 py-3 text-sm text-muted">
                  <span className="font-mono tabular-nums">{formatDate(file.createdAt)}</span>
                  {file.expiresAt && (
                    <div className="mt-0.5 inline-flex items-center gap-1 text-xs text-warning">
                      <Clock size={11} />{ttlLabel(file.expiresAt)}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center justify-end gap-1">
                    {onPreview && file.mimeType.startsWith("image/") && <IconButton onClick={() => onPreview(file)} title="Preview" className="text-muted hover:bg-paper-2 hover:text-ink"><Eye size={15} /></IconButton>}
                    {onPlay && file.status === "READY" && file.mimeType.startsWith("video/") && <IconButton onClick={() => onPlay(file)} title="Play" className="text-muted hover:bg-paper-2 hover:text-ink"><Play size={15} /></IconButton>}
                    <IconButton onClick={() => onDownload(file)} title="Download" className="text-accent hover:bg-accent/10"><Download size={15} /></IconButton>
                    {onShare && file.status === "READY" && <IconButton onClick={() => onShare(file)} title="Share" className="text-muted hover:bg-paper-2 hover:text-ink"><Share2 size={15} /></IconButton>}
                    {onExtendTtl && file.expiresAt && <IconButton onClick={() => onExtendTtl(file)} title="Extend TTL" className="text-muted hover:bg-paper-2 hover:text-ink"><Clock size={15} /></IconButton>}
                    {onDelete && <IconButton onClick={() => { if (confirm(`Delete "${file.name}"?`)) onDelete(file); }} title="Delete" className="text-error hover:bg-error/10 hover:text-error"><Trash2 size={15} /></IconButton>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm text-muted">
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage === 1} className="rounded-md p-2 transition-colors duration-short ease-out hover:bg-paper-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"><ChevronLeft size={18} /></button>
          <span className="font-mono tabular-nums">Page <span className="text-ink">{safePage}</span> / {totalPages}</span>
          <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage === totalPages} className="rounded-md p-2 transition-colors duration-short ease-out hover:bg-paper-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"><ChevronRight size={18} /></button>
        </div>
      )}
    </div>
  );
}

function EmptyState() { return <div className="rounded-card border border-dashed border-rule bg-paper px-4 py-10 text-center text-sm text-muted"><EmptyCopy /></div>; }
function EmptyCopy() { return <><p className="mb-1 text-base text-ink-2">No files yet</p><p>Drop files above or click Upload</p></>; }
function FilteredEmptyState() { return <div className="rounded-card border border-rule bg-paper px-4 py-8 text-center text-sm text-muted">No files match your search</div>; }

function FolderCard({
  folder, isOver, dragHandlers, onOpen, onDownload, onRename, onDelete, onShare,
}: {
  folder: FolderItem;
  isOver: boolean;
  dragHandlers: React.HTMLAttributes<HTMLDivElement>;
  onOpen: () => void;
  onDownload?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onShare?: () => void;
}) {
  return (
    <div
      className={`w-full rounded-card border p-4 transition-colors duration-short ease-out ${isOver ? "border-accent/60 bg-accent/10" : "border-rule bg-paper hover:border-rule-2 hover:bg-paper-2"}`}
      {...dragHandlers}
    >
      <div className="flex items-start gap-3">
        <button onClick={onOpen} className="rounded-md bg-paper-2 p-2 text-ink-2">
          <Folder size={18} className={isOver ? "text-accent" : undefined} />
        </button>
        <button onClick={onOpen} className="min-w-0 flex-1 text-left">
          <p className="truncate text-sm font-medium text-ink">{folder.name}</p>
          <p className="mt-1 text-xs text-muted">
            {isOver ? "Drop here to move" : (
              <span className="font-mono tabular-nums">
                {[
                  `${folder.fileCount} items`,
                  folder.totalSizeBytes ? formatSize(folder.totalSizeBytes) : null,
                ].filter(Boolean).join(" · ")}
              </span>
            )}
          </p>
        </button>
        <FolderActionMenu
          folderName={folder.name}
          onOpen={onOpen}
          onDownload={onDownload}
          onRename={onRename}
          onDelete={onDelete}
          onShare={onShare}
        />
      </div>
    </div>
  );
}

function FolderActionMenu({ folderName, onOpen, onDownload, onRename, onDelete, onShare }: { folderName: string; onOpen: () => void; onDownload?: () => void; onRename?: () => void; onDelete?: () => void; onShare?: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);
  type Action = { label: string; icon: React.FC<{ size?: number }>; onClick: () => void; danger: boolean };
  const actions: Action[] = [
    { label: "Open", icon: Folder, onClick: onOpen, danger: false },
    ...(onShare ? [{ label: "Share", icon: Share2, onClick: onShare, danger: false }] : []),
    ...(onDownload ? [{ label: "Download as ZIP", icon: FolderDown, onClick: onDownload, danger: false }] : []),
    ...(onRename ? [{ label: "Rename", icon: Pencil, onClick: onRename, danger: false }] : []),
    ...(onDelete ? [{ label: "Delete", icon: Trash2, onClick: onDelete, danger: true }] : []),
  ];
  return (
    <div ref={wrapperRef} className="relative shrink-0">
      <button onClick={() => setOpen((v) => !v)} className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-rule-2 bg-paper text-ink-2 transition-colors duration-short ease-out hover:bg-paper-2 hover:text-ink" aria-label={`Actions for ${folderName}`}>
        <MoreVertical size={16} />
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-dropdown min-w-44 overflow-hidden rounded-card border border-rule bg-paper shadow-[0_1px_2px_oklch(24%_0.02_258/0.08)]">
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <button key={action.label} onClick={() => { setOpen(false); action.onClick(); }} className={`flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors duration-short ease-out ${action.danger ? "text-error hover:bg-error/10" : "text-ink-2 hover:bg-paper-2"}`}>
                <Icon size={16} />{action.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ttlLabel(expiresAt?: string | null): string | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return "expired";
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  return days > 0 ? `${days}d ${hours}h left` : `${hours}h left`;
}

function FileCard({ file, onDownload, onPlay, onShare, onDelete, onExtendTtl }: { file: FileItem; onDownload: () => void; onPlay?: () => void; onShare?: () => void; onDelete?: () => void; onExtendTtl?: (file: FileItem) => void }) {
  const statusChipClass =
    file.status === "READY" ? "chip chip--success" : file.status === "FAILED" ? "chip chip--error" : "chip chip--warning";
  const ttl = ttlLabel(file.expiresAt);
  return (
    <div className="rounded-card border border-rule bg-paper p-4">
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-paper-2 px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wide text-ink-2">{getFileBadge(file.mimeType)}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{file.name}</p>
              <p className="mt-1 text-xs text-muted">
                <span className="font-mono tabular-nums">{formatSize(file.size)} · {formatDate(file.createdAt)}</span>
                {ttl && <span className="ml-2 inline-flex items-center gap-1 text-warning"><Clock size={11} />{ttl}</span>}
              </p>
            </div>
            <FileActionMenu fileName={file.name} onDownload={onDownload} onPlay={onPlay} onShare={onShare} onDelete={onDelete} onExtendTtl={onExtendTtl ? () => onExtendTtl(file) : undefined} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className={statusChipClass}>{file.status}</span>
            <span className="chip tabular-nums">{file.chunkCount} chunks</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function FileActionMenu({ fileName, onDownload, onPlay, onShare, onDelete, onExtendTtl }: { fileName: string; onDownload: () => void; onPlay?: () => void; onShare?: () => void; onDelete?: () => void; onExtendTtl?: () => void }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => { if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);
  const actions = [
    onPlay ? { label: "Play", icon: Play, onClick: onPlay, danger: false } : null,
    { label: "Download", icon: Download, onClick: onDownload, danger: false },
    onShare ? { label: "Share", icon: Share2, onClick: onShare, danger: false } : null,
    onExtendTtl ? { label: "Extend TTL", icon: Clock, onClick: onExtendTtl, danger: false } : null,
    onDelete ? { label: "Delete", icon: Trash2, onClick: onDelete, danger: true } : null,
  ].filter(Boolean) as Array<{ label: string; icon: typeof Play; onClick: () => void; danger: boolean }>;
  return (
    <div ref={wrapperRef} className="relative shrink-0">
      <button onClick={() => setOpen((v) => !v)} className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-rule-2 bg-paper text-ink-2 transition-colors duration-short ease-out hover:bg-paper-2 hover:text-ink" aria-label={`Open actions for ${fileName}`}>
        <MoreVertical size={18} />
      </button>
      {open && (
        <div className="absolute right-0 top-12 z-dropdown min-w-44 overflow-hidden rounded-card border border-rule bg-paper shadow-[0_1px_2px_oklch(24%_0.02_258/0.08)]">
          {actions.map((action) => {
            const Icon = action.icon;
            return (
              <button key={action.label} onClick={() => { setOpen(false); action.onClick(); }} className={`flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors duration-short ease-out ${action.danger ? "text-error hover:bg-error/10" : "text-ink-2 hover:bg-paper-2"}`}>
                <Icon size={16} />{action.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SortHeader({ label, sortKey, current, onSort }: { label: string; sortKey: SortKey; current: { key: SortKey; dir: SortDir }; onSort: (key: SortKey) => void }) {
  const active = current.key === sortKey;
  return (
    <th className="cursor-pointer select-none px-4 py-3 text-left font-mono text-xs font-medium uppercase tracking-wide text-muted transition-colors duration-short ease-out hover:text-ink-2" onClick={() => onSort(sortKey)}>
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? current.dir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} /> : <span className="w-3" />}
      </span>
    </th>
  );
}

function IconButton({ children, onClick, title, className }: { children: React.ReactNode; onClick: () => void; title: string; className?: string }) {
  return <button onClick={onClick} title={title} className={`rounded-md p-2 transition-colors duration-short ease-out ${className ?? "text-muted hover:bg-paper-2 hover:text-ink"}`}>{children}</button>;
}

function formatSize(bytes: string): string {
  const size = Number(bytes);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  return `${(size / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(value: string): string { return new Date(value).toLocaleString(); }
function getFileBadge(mimeType: string): string {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}
