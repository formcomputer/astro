"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  Activity, AlertTriangle, Box, ChevronRight, Copy, Download, FileText,
  Gamepad2, Globe, Hash, LayoutGrid, Newspaper, Plus, RefreshCw,
  Server, Shield, Trash2, Users, Wifi, X, Zap, Eye, EyeOff, Pencil, Check
} from "lucide-react";

// ─── API ────────────────────────────────────────────────────────────────
const BASE = "/api";
let _token: string | null = null;
function setToken(t: string) { _token = t; if (typeof window !== "undefined") localStorage.setItem("astro_admin_token", t); }
function getToken(): string | null {
  if (_token) return _token;
  if (typeof window !== "undefined") _token = localStorage.getItem("astro_admin_token");
  return _token;
}
function clearToken() { _token = null; if (typeof window !== "undefined") localStorage.removeItem("astro_admin_token"); }

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const tok = getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) { const err = await res.json().catch(() => ({ error: res.statusText })); throw new Error(err.error || "Request failed"); }
  return res.json();
}

const api = {
  login: (u: string, p: string) => req<{ token: string; user: { id: string; username: string; role: string } }>("POST", "/auth/login", { username: u, password: p }),
  stats: () => req<Stats>("GET", "/stats"),
  status: () => req<Status>("GET", "/status"),
  projects: () => req<Project[]>("GET", "/projects"),
  createProject: (name: string, description: string) => req<{ id: string; tag: string }>("POST", "/projects", { name, description }),
  updateProjectStatus: (id: string, status: string) => req<{ ok: boolean }>("PUT", `/projects/${id}/status`, { status }),
  deleteProject: (id: string) => req<{ ok: boolean }>("DELETE", `/projects/${id}`),
  getModule: (id: string) => fetch(`${BASE}/projects/${id}/module`, { headers: { Authorization: `Bearer ${getToken()}` } }).then(r => r.text()),
  flags: () => req<Flag[]>("GET", "/flags"),
  dismissFlag: (id: string) => req<{ ok: boolean }>("POST", `/flags/${id}/dismiss`),
  removeFlag: (id: string) => req<{ ok: boolean }>("POST", `/flags/${id}/remove`),
  refreshIP: () => req<{ ip: string; changed: boolean; old: string }>("GET", "/network/ip"),
  // games
  adminGames: () => req<Game[]>("GET", "/admin/games"),
  createGame: (d: Partial<Game>) => req<{ ok: boolean; id: string }>("POST", "/admin/games", d),
  updateGame: (id: string, d: Partial<Game>) => req<{ ok: boolean }>("PUT", `/admin/games/${id}`, d),
  deleteGame: (id: string) => req<{ ok: boolean }>("DELETE", `/admin/games/${id}`),
  // newsletters
  adminNewsletters: () => req<Newsletter[]>("GET", "/admin/newsletters"),
  adminNewsletter: (id: string) => req<Newsletter>("GET", `/admin/newsletters/${id}`),
  createNewsletter: (d: Partial<Newsletter>) => req<{ ok: boolean; id: string }>("POST", "/admin/newsletters", d),
  updateNewsletter: (id: string, d: Partial<Newsletter>) => req<{ ok: boolean }>("PUT", `/admin/newsletters/${id}`, d),
  publishNewsletter: (id: string) => req<{ ok: boolean }>("POST", `/admin/newsletters/${id}/publish`),
  unpublishNewsletter: (id: string) => req<{ ok: boolean }>("POST", `/admin/newsletters/${id}/unpublish`),
  deleteNewsletter: (id: string) => req<{ ok: boolean }>("DELETE", `/admin/newsletters/${id}`),
  // users
  adminUsers: () => req<AdminUser[]>("GET", "/admin/users"),
  updateUserRole: (id: string, role: string) => req<{ ok: boolean }>("PUT", `/admin/users/${id}/role`, { role }),
  resetPassword: (id: string, password: string) => req<{ ok: boolean }>("POST", `/admin/users/${id}/reset-password`, { password }),
  deleteUser: (id: string) => req<{ ok: boolean }>("DELETE", `/admin/users/${id}`),
};

// ─── Types ───────────────────────────────────────────────────────────────
type Stats = { projects: number; approved: number; activePeers: number; totalDocs: number; totalMessages: number; pendingFlags: number; activeCalls: number; uptime: number; totalGames: number; publishedGames: number; totalNewsletters: number; totalUsers: number };
type Status = { uptime: number; network: { localIP: string; publicIP: string; lastSeen: string }; ports: Record<string, number>; activeCalls: number };
type Project = { id: string; name: string; description: string; status: string; created_at: string; activePeers: number };
type Flag = { id: string; project_id: string; content_type: string; content_id: string; reason: string; created_at: string };
type Game = { id: string; title: string; slug: string; description: string; genre: string; cover_url: string; banner_url: string; launch_url: string; asset_size: string; price: number; is_free: number; sort_order: number; published: number; created_at: string };
type Newsletter = { id: string; subject: string; body_html: string; author_id: string; author_name: string; published: number; published_at: string; created_at: string };
type AdminUser = { id: string; username: string; email: string; role: string; bio: string; avatar_url: string; created_at: string; last_login: string };
type Tab = "overview" | "games" | "newsletters" | "users" | "projects" | "moderation" | "network";

// ─── Helpers ─────────────────────────────────────────────────────────────
function fmt(s: number) { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`; }
function fmtDate(iso: string) { if (!iso) return "—"; return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); }
function fmtTime(iso: string) { if (!iso) return ""; return new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }); }
function slug(s: string) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

// ─── Logo ─────────────────────────────────────────────────────────────────
function AstroLogo({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="9" stroke="var(--primary)" strokeWidth="1.5" />
      <circle cx="10" cy="10" r="3" fill="var(--primary)" />
      <line x1="10" y1="1" x2="10" y2="4.5" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="10" y1="15.5" x2="10" y2="19" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="1" y1="10" x2="4.5" y2="10" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" />
      <line x1="15.5" y1="10" x2="19" y2="10" stroke="var(--primary)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

// ─── Status Pill ─────────────────────────────────────────────────────────
function StatusPill({ status }: { status: string }) {
  const cfg: Record<string, string> = {
    approved: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
    pending:  "bg-amber-500/10 border-amber-500/20 text-amber-400",
    revoked:  "bg-red-500/10 border-red-500/20 text-red-400",
    published:"bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
    draft:    "bg-muted border-border text-muted-foreground",
    admin:    "bg-primary/10 border-primary/20 text-primary",
    writer:   "bg-secondary/20 border-secondary/30 text-secondary-foreground",
    moderator:"bg-amber-500/10 border-amber-500/20 text-amber-400",
    user:     "bg-muted border-border text-muted-foreground",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-pixel border ${cfg[status] ?? cfg.user}`}>
      {status}
    </span>
  );
}

// ─── Stat Card ───────────────────────────────────────────────────────────
function StatCard({ label, value, sub, icon: Icon, accent }: { label: string; value: string | number; sub?: string; icon: React.ElementType; accent?: boolean }) {
  return (
    <div className={`relative rounded-xl border bg-card p-4 overflow-hidden transition-all hover:border-border/80 ${accent ? "border-primary/30" : "border-border"}`}>
      {accent && <div className="absolute inset-0 bg-primary/[0.03] pointer-events-none" />}
      <div className="flex items-start justify-between mb-3">
        <p className="font-pixel text-muted-foreground">{label}</p>
        <div className={`p-1.5 rounded-lg ${accent ? "bg-primary/15" : "bg-muted"}`}>
          <Icon size={13} className={accent ? "text-primary" : "text-muted-foreground"} />
        </div>
      </div>
      <p className="text-2xl font-semibold tracking-tight text-foreground tabular-nums font-pixel">{value}</p>
      {sub && <p className="font-pixel text-muted-foreground/60 mt-1">{sub}</p>}
    </div>
  );
}

// ─── Row Action Buttons ──────────────────────────────────────────────────
function Btn({ children, onClick, variant = "ghost", className = "" }: { children: React.ReactNode; onClick: () => void; variant?: "ghost" | "danger" | "primary" | "success"; className?: string }) {
  const base = "inline-flex items-center gap-1 font-pixel px-2 py-1 rounded-lg border transition-all cursor-pointer";
  const v = {
    ghost:   "text-muted-foreground hover:text-foreground border-border hover:border-border/80 hover:bg-muted/40",
    danger:  "text-red-400 hover:text-red-300 border-red-500/20 hover:border-red-500/40 bg-red-500/5",
    primary: "text-primary hover:text-primary/80 border-primary/20 hover:border-primary/40 bg-primary/5",
    success: "text-emerald-400 hover:text-emerald-300 border-emerald-500/20 hover:border-emerald-500/40 bg-emerald-500/5",
  };
  return <button onClick={onClick} className={`${base} ${v[variant]} ${className}`}>{children}</button>;
}

// ─── Table Shell ─────────────────────────────────────────────────────────
function Table({ cols, children, empty, emptyIcon: EmptyIcon }: { cols: string[]; children: React.ReactNode; empty?: boolean; emptyIcon?: React.ElementType }) {
  return (
    <div className="rounded-xl border border-border overflow-hidden">
      <div className={`grid gap-0 border-b border-border bg-muted/30 px-4 py-2`} style={{ gridTemplateColumns: `repeat(${cols.length}, 1fr)` }}>
        {cols.map((c, i) => <div key={i} className="font-pixel text-muted-foreground">{c}</div>)}
      </div>
      {empty && EmptyIcon ? (
        <div className="p-12 text-center">
          <EmptyIcon size={24} className="text-muted-foreground/20 mx-auto mb-3" />
          <p className="font-pixel text-muted-foreground">Nothing here yet</p>
        </div>
      ) : children}
    </div>
  );
}

// ─── Login ───────────────────────────────────────────────────────────────
function Login({ onLogin }: { onLogin: () => void }) {
  const [u, setU] = useState(""); const [p, setP] = useState(""); const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState("");
  async function submit(e: React.FormEvent) {
    e.preventDefault(); if (!u || !p) return; setLoading(true);
    try { const res = await api.login(u, p); setToken(res.token); onLogin(); }
    catch (err: unknown) { toast.error(err instanceof Error ? err.message : "Login failed"); }
    finally { setLoading(false); }
  }
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] rounded-full bg-primary/[0.04] blur-3xl" />
      </div>
      <div className="w-full max-w-[360px] relative">
        <div className="flex flex-col items-center mb-8 gap-3">
          <AstroLogo size={36} />
          <div className="text-center">
            <p className="font-pixel text-[15px] text-foreground">Astro Core</p>
            <p className="font-pixel text-muted-foreground/70 mt-1">Infrastructure Dashboard</p>
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-card p-6">
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <label className={`font-pixel transition-colors ${focused === 'u' ? 'text-primary' : 'text-muted-foreground'}`}>Username</label>
              <Input value={u} onChange={e => setU(e.target.value)} onFocus={() => setFocused('u')} onBlur={() => setFocused('')}
                placeholder="admin" autoFocus className="h-9 bg-background border-border text-sm placeholder:text-muted-foreground/30 focus-visible:ring-1 focus-visible:ring-primary focus-visible:border-primary" />
            </div>
            <div className="space-y-1.5">
              <label className={`font-pixel transition-colors ${focused === 'p' ? 'text-primary' : 'text-muted-foreground'}`}>Password</label>
              <Input type="password" value={p} onChange={e => setP(e.target.value)} onFocus={() => setFocused('p')} onBlur={() => setFocused('')}
                placeholder="••••••••••••" className="h-9 bg-background border-border text-sm placeholder:text-muted-foreground/30 focus-visible:ring-1 focus-visible:ring-primary focus-visible:border-primary" />
            </div>
            <Button type="submit" disabled={loading || !u || !p} className="w-full h-9 bg-primary hover:bg-primary/90 text-primary-foreground font-pixel mt-1">
              {loading ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </div>
        <p className="font-pixel text-muted-foreground/40 text-center mt-5">ASTRO · PORT 2000 · LOCALHOST</p>
      </div>
    </div>
  );
}

// ─── Overview ────────────────────────────────────────────────────────────
function Overview({ stats, status }: { stats: Stats | null; status: Status | null }) {
  if (!stats || !status) return <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{[...Array(12)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Games" value={stats.totalGames} sub={`${stats.publishedGames} published`} icon={Gamepad2} accent />
        <StatCard label="Users" value={stats.totalUsers} sub="registered" icon={Users} />
        <StatCard label="Newsletters" value={stats.totalNewsletters} sub="published" icon={Newspaper} />
        <StatCard label="Uptime" value={fmt(stats.uptime)} sub="since last restart" icon={Activity} />
        <StatCard label="Projects" value={stats.projects} sub={`${stats.approved} approved`} icon={Box} />
        <StatCard label="Active Peers" value={stats.activePeers} sub="last 5 min" icon={Wifi} />
        <StatCard label="Active Calls" value={stats.activeCalls} sub="WebRTC" icon={Zap} />
        <StatCard label="Messages" value={stats.totalMessages.toLocaleString()} sub="total" icon={Hash} />
        <StatCard label="Documents" value={stats.totalDocs.toLocaleString()} sub="data store" icon={FileText} />
        <StatCard label="Flagged" value={stats.pendingFlags} sub="pending review" icon={AlertTriangle} accent={stats.pendingFlags > 0} />
        <StatCard label="Public IP" value={status.network.publicIP} sub={`local: ${status.network.localIP}`} icon={Globe} />
        <StatCard label="Calls" value={stats.activeCalls} sub="live WebRTC sessions" icon={Zap} />
      </div>
      <div>
        <p className="font-pixel text-muted-foreground mb-3">Services</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {Object.entries(status.ports).map(([name, port]) => (
            <div key={name} className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0 shadow-[0_0_6px_rgba(52,211,153,0.6)]" />
              <div>
                <p className="text-xs text-foreground capitalize">{name.replace("TLS", " TLS")}</p>
                <p className="font-pixel text-muted-foreground">:{port}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Games ───────────────────────────────────────────────────────────────
function Games() {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Game | null>(null);
  const emptyGame: Partial<Game> = { title: "", slug: "", description: "", genre: "", cover_url: "", banner_url: "", launch_url: "", asset_size: "", price: 0, is_free: 1, sort_order: 0, published: 0 };
  const [form, setForm] = useState<Partial<Game>>(emptyGame);

  const load = useCallback(async () => {
    try { setGames(await api.adminGames()); } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  function openNew() { setEditing(null); setForm(emptyGame); setShowForm(true); }
  function openEdit(g: Game) { setEditing(g); setForm({ ...g }); setShowForm(true); }

  async function save() {
    try {
      if (editing) { await api.updateGame(editing.id, form); toast.success("Game updated"); }
      else { await api.createGame(form); toast.success("Game created"); }
      setShowForm(false); await load();
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  async function toggle(g: Game) {
    try { await api.updateGame(g.id, { published: g.published ? 0 : 1 }); await load(); }
    catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  async function del(id: string) {
    if (!confirm("Delete this game?")) return;
    try { await api.deleteGame(id); toast.success("Deleted"); await load(); }
    catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  const F = ({ label, k, placeholder, type = "text" }: { label: string; k: keyof Game; placeholder?: string; type?: string }) => (
    <div className="space-y-1.5">
      <label className="font-pixel text-muted-foreground">{label}</label>
      <Input type={type} value={String(form[k] ?? "")} onChange={e => setForm(p => ({ ...p, [k]: type === "number" ? Number(e.target.value) : e.target.value }))}
        placeholder={placeholder} className="h-9 bg-background border-border text-sm focus-visible:ring-1 focus-visible:ring-primary" />
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div><p className="text-sm font-semibold">Games</p><p className="font-pixel text-muted-foreground mt-0.5">{games.length} / 100</p></div>
        <Button onClick={openNew} size="sm" className="h-8 px-3 bg-primary hover:bg-primary/90 text-primary-foreground font-pixel gap-1.5" disabled={games.length >= 100}>
          <Plus size={12} /> New Game
        </Button>
      </div>

      {loading ? <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)}</div> : (
        <Table cols={["Title", "Genre", "Price", "Status", ""]} empty={!games.length} emptyIcon={Gamepad2}>
          {games.map((g, i) => (
            <div key={g.id} className={`grid gap-0 px-4 py-3 items-center hover:bg-muted/20 transition-colors ${i < games.length - 1 ? "border-b border-border/60" : ""}`}
              style={{ gridTemplateColumns: "1fr 100px 80px 90px auto" }}>
              <div>
                <p className="text-sm font-medium text-foreground">{g.title}</p>
                <p className="font-pixel text-muted-foreground/50">{g.slug}</p>
              </div>
              <p className="font-pixel text-muted-foreground">{g.genre || "—"}</p>
              <p className="font-pixel text-muted-foreground">{g.is_free ? "Free" : `$${Number(g.price).toFixed(2)}`}</p>
              <StatusPill status={g.published ? "published" : "draft"} />
              <div className="flex items-center gap-1.5 justify-end">
                <Btn onClick={() => toggle(g)} variant={g.published ? "ghost" : "success"}>{g.published ? <EyeOff size={11} /> : <Eye size={11} />}{g.published ? "Unpublish" : "Publish"}</Btn>
                <Btn onClick={() => openEdit(g)} variant="primary"><Pencil size={11} />Edit</Btn>
                <Btn onClick={() => del(g.id)} variant="danger"><Trash2 size={11} /></Btn>
              </div>
            </div>
          ))}
        </Table>
      )}

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="bg-card border-border text-foreground max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-pixel text-foreground flex items-center gap-2">
              <Gamepad2 size={14} className="text-primary" />{editing ? "Edit Game" : "New Game"}
            </DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 mt-2">
            <div className="col-span-2"><F label="Title" k="title" placeholder="My Awesome Game" /></div>
            <F label="Slug" k="slug" placeholder="my-awesome-game" />
            <F label="Genre" k="genre" placeholder="Action" />
            <div className="col-span-2">
              <label className="font-pixel text-muted-foreground block mb-1.5">Description</label>
              <Textarea value={form.description ?? ""} onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                placeholder="What is this game about?" rows={3} className="bg-background border-border text-sm resize-none focus-visible:ring-1 focus-visible:ring-primary" />
            </div>
            <div className="col-span-2"><F label="Launch URL" k="launch_url" placeholder="file:///path/to/game.html or /cdn/games/mygame/" /></div>
            <F label="Cover URL" k="cover_url" placeholder="/cdn/covers/game.jpg" />
            <F label="Banner URL" k="banner_url" placeholder="/cdn/banners/game.jpg" />
            <F label="Asset Size" k="asset_size" placeholder="42 MB" />
            <F label="Sort Order" k="sort_order" type="number" placeholder="0" />
            <div className="col-span-2 flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={!!form.is_free} onChange={e => setForm(p => ({ ...p, is_free: e.target.checked ? 1 : 0 }))} className="rounded accent-primary" />
                <span className="font-pixel text-foreground">Free</span>
              </label>
              {!form.is_free && <div className="flex-1"><F label="Price ($)" k="price" type="number" placeholder="4.99" /></div>}
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={!!form.published} onChange={e => setForm(p => ({ ...p, published: e.target.checked ? 1 : 0 }))} className="rounded accent-primary" />
                <span className="font-pixel text-foreground">Published</span>
              </label>
            </div>
          </div>
          <div className="flex gap-2 mt-4">
            <Button onClick={() => setShowForm(false)} variant="outline" className="flex-1 h-9 font-pixel">Cancel</Button>
            <Button onClick={save} className="flex-1 h-9 bg-primary hover:bg-primary/90 text-primary-foreground font-pixel">{editing ? "Save Changes" : "Create Game"}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Newsletters ─────────────────────────────────────────────────────────
function Newsletters() {
  const [items, setItems] = useState<Newsletter[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Newsletter | null>(null);
  const [form, setForm] = useState({ subject: "", body_html: "" });
  const [showForm, setShowForm] = useState(false);
  const [preview, setPreview] = useState(false);

  const load = useCallback(async () => {
    try { setItems(await api.adminNewsletters()); } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function openEdit(n: Newsletter) {
    const full = await api.adminNewsletter(n.id);
    setEditing(full); setForm({ subject: full.subject, body_html: full.body_html }); setShowForm(true);
  }
  function openNew() { setEditing(null); setForm({ subject: "", body_html: "" }); setShowForm(true); }

  async function save() {
    try {
      if (editing) { await api.updateNewsletter(editing.id, form); toast.success("Saved"); }
      else { await api.createNewsletter(form); toast.success("Draft created"); }
      setShowForm(false); await load();
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  async function togglePublish(n: Newsletter) {
    try {
      if (n.published) { await api.unpublishNewsletter(n.id); toast.success("Unpublished"); }
      else { await api.publishNewsletter(n.id); toast.success("Published"); }
      await load();
    } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  async function del(id: string) {
    if (!confirm("Delete this newsletter?")) return;
    try { await api.deleteNewsletter(id); toast.success("Deleted"); await load(); }
    catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div><p className="text-sm font-semibold">Newsletters</p><p className="font-pixel text-muted-foreground mt-0.5">{items.filter(n => n.published).length} published · {items.filter(n => !n.published).length} drafts</p></div>
        <Button onClick={openNew} size="sm" className="h-8 px-3 bg-primary hover:bg-primary/90 text-primary-foreground font-pixel gap-1.5">
          <Plus size={12} /> New Issue
        </Button>
      </div>
      {loading ? <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)}</div> : (
        <Table cols={["Subject", "Author", "Date", "Status", ""]} empty={!items.length} emptyIcon={Newspaper}>
          {items.map((n, i) => (
            <div key={n.id} className={`grid gap-0 px-4 py-3 items-center hover:bg-muted/20 transition-colors ${i < items.length - 1 ? "border-b border-border/60" : ""}`}
              style={{ gridTemplateColumns: "1fr 100px 110px 90px auto" }}>
              <p className="text-sm font-medium text-foreground truncate pr-4">{n.subject}</p>
              <p className="font-pixel text-muted-foreground">{n.author_name}</p>
              <p className="font-pixel text-muted-foreground">{n.published ? fmtDate(n.published_at) : fmtDate(n.created_at)}</p>
              <StatusPill status={n.published ? "published" : "draft"} />
              <div className="flex items-center gap-1.5 justify-end">
                <Btn onClick={() => togglePublish(n)} variant={n.published ? "ghost" : "success"}>{n.published ? <EyeOff size={11} /> : <Eye size={11} />}{n.published ? "Unpublish" : "Publish"}</Btn>
                <Btn onClick={() => openEdit(n)} variant="primary"><Pencil size={11} />Edit</Btn>
                <Btn onClick={() => del(n.id)} variant="danger"><Trash2 size={11} /></Btn>
              </div>
            </div>
          ))}
        </Table>
      )}

      <Dialog open={showForm} onOpenChange={v => { setShowForm(v); setPreview(false); }}>
        <DialogContent className="bg-card border-border text-foreground max-w-3xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <DialogTitle className="font-pixel text-foreground flex items-center gap-2">
                <Newspaper size={14} className="text-primary" />{editing ? "Edit Issue" : "New Issue"}
              </DialogTitle>
              <Button onClick={() => setPreview(p => !p)} variant="outline" size="sm" className="h-7 px-2 font-pixel gap-1 text-xs">
                {preview ? <Pencil size={10} /> : <Eye size={10} />}{preview ? "Edit" : "Preview"}
              </Button>
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto space-y-3 mt-2 min-h-0">
            <div className="space-y-1.5">
              <label className="font-pixel text-muted-foreground">Subject</label>
              <Input value={form.subject} onChange={e => setForm(p => ({ ...p, subject: e.target.value }))}
                placeholder="Issue #1 — What's new in Astro" className="h-9 bg-background border-border text-sm focus-visible:ring-1 focus-visible:ring-primary" />
            </div>
            <div className="space-y-1.5">
              <label className="font-pixel text-muted-foreground">Body {preview ? "(preview)" : "(HTML)"}</label>
              {preview ? (
                <div className="rounded-xl border border-border bg-background p-4 min-h-[300px] prose prose-invert prose-sm max-w-none overflow-y-auto"
                  dangerouslySetInnerHTML={{ __html: form.body_html || "<p class='text-muted-foreground text-sm'>Nothing to preview.</p>" }} />
              ) : (
                <Textarea value={form.body_html} onChange={e => setForm(p => ({ ...p, body_html: e.target.value }))}
                  placeholder="<h2>Hello Astro</h2><p>This week's update…</p>"
                  rows={14} className="bg-background border-border font-pixel text-[11px] resize-none focus-visible:ring-1 focus-visible:ring-primary" />
              )}
            </div>
          </div>
          <div className="flex gap-2 pt-3 border-t border-border mt-2">
            <Button onClick={() => setShowForm(false)} variant="outline" className="flex-1 h-9 font-pixel">Cancel</Button>
            <Button onClick={save} className="flex-1 h-9 bg-primary hover:bg-primary/90 text-primary-foreground font-pixel">{editing ? "Save Changes" : "Save Draft"}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Users ───────────────────────────────────────────────────────────────
const ROLES = ["user", "writer", "moderator", "admin"] as const;

function UsersPanel() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [resetTarget, setResetTarget] = useState<AdminUser | null>(null);
  const [newPw, setNewPw] = useState("");
  const [editingRole, setEditingRole] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setUsers(await api.adminUsers()); } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function setRole(id: string, role: string) {
    try { await api.updateUserRole(id, role); toast.success(`Role → ${role}`); setEditingRole(null); await load(); }
    catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  async function resetPw() {
    if (!resetTarget || newPw.length < 8) { toast.error("Min 8 characters"); return; }
    try { await api.resetPassword(resetTarget.id, newPw); toast.success("Password reset"); setResetTarget(null); setNewPw(""); }
    catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  async function del(id: string, username: string) {
    if (!confirm(`Delete user "${username}"? This cannot be undone.`)) return;
    try { await api.deleteUser(id); toast.success("User deleted"); await load(); }
    catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-semibold">Users</p>
        <p className="font-pixel text-muted-foreground mt-0.5">{users.length} registered</p>
      </div>
      {loading ? <div className="space-y-2">{[...Array(4)].map((_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)}</div> : (
        <Table cols={["User", "Role", "Joined", "Last Login", ""]} empty={!users.length} emptyIcon={Users}>
          {users.map((u, i) => (
            <div key={u.id} className={`grid gap-0 px-4 py-3 items-center hover:bg-muted/20 transition-colors ${i < users.length - 1 ? "border-b border-border/60" : ""}`}
              style={{ gridTemplateColumns: "1fr 140px 100px 100px auto" }}>
              <div>
                <p className="text-sm font-medium text-foreground">{u.username}</p>
                {u.email && <p className="font-pixel text-muted-foreground/50">{u.email}</p>}
              </div>
              <div>
                {editingRole === u.id ? (
                  <div className="flex items-center gap-1 flex-wrap">
                    {ROLES.map(r => (
                      <button key={r} onClick={() => setRole(u.id, r)}
                        className={`font-pixel px-2 py-0.5 rounded border transition-all text-[10px] ${u.role === r ? "bg-primary/20 border-primary/40 text-primary" : "border-border text-muted-foreground hover:border-border/80 hover:text-foreground"}`}>
                        {r}
                      </button>
                    ))}
                    <button onClick={() => setEditingRole(null)} className="text-muted-foreground hover:text-foreground transition-colors"><X size={11} /></button>
                  </div>
                ) : (
                  <button onClick={() => setEditingRole(u.id)} className="group flex items-center gap-1.5">
                    <StatusPill status={u.role} />
                    <Pencil size={10} className="text-muted-foreground/0 group-hover:text-muted-foreground/60 transition-all" />
                  </button>
                )}
              </div>
              <p className="font-pixel text-muted-foreground">{fmtDate(u.created_at)}</p>
              <p className="font-pixel text-muted-foreground">{u.last_login ? fmtDate(u.last_login) : "—"}</p>
              <div className="flex items-center gap-1.5 justify-end">
                <Btn onClick={() => { setResetTarget(u); setNewPw(""); }} variant="ghost"><Shield size={11} />Reset PW</Btn>
                {u.role !== "admin" && <Btn onClick={() => del(u.id, u.username)} variant="danger"><Trash2 size={11} /></Btn>}
              </div>
            </div>
          ))}
        </Table>
      )}

      <Dialog open={!!resetTarget} onOpenChange={v => { if (!v) setResetTarget(null); }}>
        <DialogContent className="bg-card border-border text-foreground max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-pixel text-foreground flex items-center gap-2">
              <Shield size={14} className="text-primary" />Reset Password — {resetTarget?.username}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 mt-2">
            <div className="space-y-1.5">
              <label className="font-pixel text-muted-foreground">New Password (min 8 chars)</label>
              <Input type="password" value={newPw} onChange={e => setNewPw(e.target.value)}
                placeholder="••••••••••••" className="h-9 bg-background border-border text-sm focus-visible:ring-1 focus-visible:ring-primary" />
            </div>
            <div className="flex gap-2">
              <Button onClick={() => setResetTarget(null)} variant="outline" className="flex-1 h-9 font-pixel">Cancel</Button>
              <Button onClick={resetPw} disabled={newPw.length < 8} className="flex-1 h-9 bg-primary hover:bg-primary/90 text-primary-foreground font-pixel">Reset</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Projects ────────────────────────────────────────────────────────────
function Projects() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState(""); const [desc, setDesc] = useState("");
  const [showNew, setShowNew] = useState(false); const [creating, setCreating] = useState(false);
  const [moduleContent, setModuleContent] = useState<string | null>(null);
  const [moduleProject, setModuleProject] = useState("");

  const load = useCallback(async () => {
    try { setProjects(await api.projects()); } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function create() {
    if (!name.trim()) return; setCreating(true);
    try { await api.createProject(name.trim(), desc.trim()); toast.success("Project created"); setName(""); setDesc(""); setShowNew(false); await load(); }
    catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); } finally { setCreating(false); }
  }
  async function setStatus(id: string, status: string) {
    try { await api.updateProjectStatus(id, status); toast.success(`Project ${status}`); await load(); } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }
  async function del(id: string) {
    if (!confirm("Delete this project?")) return;
    try { await api.deleteProject(id); toast.success("Deleted"); await load(); } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }
  async function getModule(id: string, n: string) {
    try { setModuleContent(await api.getModule(id)); setModuleProject(n); } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div><p className="text-sm font-semibold">Projects</p><p className="font-pixel text-muted-foreground mt-0.5">{projects.length} registered</p></div>
        <Button onClick={() => setShowNew(true)} size="sm" className="h-8 px-3 bg-primary hover:bg-primary/90 text-primary-foreground font-pixel gap-1.5"><Plus size={12} />New</Button>
      </div>
      {loading ? <div className="space-y-2">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)}</div> : (
        <Table cols={["Project", "Status", "Peers", "Created", ""]} empty={!projects.length} emptyIcon={Box}>
          {projects.map((p, i) => (
            <div key={p.id} className={`grid gap-0 px-4 py-3 items-center hover:bg-muted/20 transition-colors ${i < projects.length - 1 ? "border-b border-border/60" : ""}`}
              style={{ gridTemplateColumns: "1fr 100px 60px 100px auto" }}>
              <div>
                <p className="text-sm font-medium">{p.name}</p>
                <p className="font-pixel text-muted-foreground/40">{p.id}</p>
              </div>
              <StatusPill status={p.status} />
              <p className="font-pixel text-muted-foreground">{p.activePeers}</p>
              <p className="font-pixel text-muted-foreground">{fmtDate(p.created_at)}</p>
              <div className="flex items-center gap-1.5 justify-end">
                {p.status !== "approved" && <Btn onClick={() => setStatus(p.id, "approved")} variant="success"><Check size={11} />Approve</Btn>}
                {p.status === "approved" && <Btn onClick={() => setStatus(p.id, "revoked")} variant="ghost"><EyeOff size={11} />Revoke</Btn>}
                <Btn onClick={() => getModule(p.id, p.name)} variant="primary"><Download size={11} />SDK</Btn>
                <Btn onClick={() => del(p.id)} variant="danger"><Trash2 size={11} /></Btn>
              </div>
            </div>
          ))}
        </Table>
      )}
      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent className="bg-card border-border text-foreground max-w-sm">
          <DialogHeader><DialogTitle className="font-pixel flex items-center gap-2"><Plus size={14} className="text-primary" />New Project</DialogTitle></DialogHeader>
          <div className="space-y-3 mt-1">
            <div className="space-y-1.5"><label className="font-pixel text-muted-foreground">Name</label><Input value={name} onChange={e => setName(e.target.value)} placeholder="astro-client" className="h-9 bg-background border-border text-sm focus-visible:ring-1 focus-visible:ring-primary" /></div>
            <div className="space-y-1.5"><label className="font-pixel text-muted-foreground">Description <span className="text-muted-foreground/40">(optional)</span></label><Input value={desc} onChange={e => setDesc(e.target.value)} placeholder="What is this project?" className="h-9 bg-background border-border text-sm focus-visible:ring-1 focus-visible:ring-primary" /></div>
            <div className="flex gap-2 pt-1">
              <Button onClick={() => setShowNew(false)} variant="outline" className="flex-1 h-9 font-pixel">Cancel</Button>
              <Button onClick={create} disabled={creating || !name.trim()} className="flex-1 h-9 bg-primary hover:bg-primary/90 text-primary-foreground font-pixel">{creating ? "Creating…" : "Create"}</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!!moduleContent} onOpenChange={() => setModuleContent(null)}>
        <DialogContent className="bg-card border-border text-foreground max-w-xl">
          <DialogHeader><DialogTitle className="font-pixel flex items-center gap-2"><Server size={14} className="text-primary" />Astro Client SDK — {moduleProject}</DialogTitle></DialogHeader>
          <div className="mt-2 space-y-3">
            <p className="font-pixel text-muted-foreground">Drop into any HTML file to connect to Astro Core. Server IP is obfuscated — never appears in plaintext.</p>
            <div className="rounded-xl bg-background border border-border p-4 overflow-auto max-h-48">
              <code className="font-pixel text-muted-foreground whitespace-pre-wrap break-all">{moduleContent?.slice(0, 600)}…</code>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => { if (moduleContent) { navigator.clipboard.writeText(moduleContent); toast.success("Copied"); } }} className="flex-1 h-9 bg-primary hover:bg-primary/90 text-primary-foreground font-pixel gap-1.5"><Copy size={12} />Copy</Button>
              <Button onClick={() => { if (!moduleContent) return; const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([moduleContent], { type: "text/javascript" })); a.download = `astro-sdk-${moduleProject.toLowerCase().replace(/\s+/g, '-')}.js`; a.click(); }} variant="outline" className="flex-1 h-9 font-pixel gap-1.5"><Download size={12} />Download .js</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Moderation ──────────────────────────────────────────────────────────
function Moderation() {
  const [flags, setFlags] = useState<Flag[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => { try { setFlags(await api.flags()); } catch { } finally { setLoading(false); } }, []);
  useEffect(() => { load(); }, [load]);
  async function dismiss(id: string) { try { await api.dismissFlag(id); await load(); } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); } }
  async function remove(id: string) { try { await api.removeFlag(id); toast.success("Content removed"); await load(); } catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); } }
  const reasonColors: Record<string, string> = { slur: "bg-red-500/10 border-red-500/20 text-red-400", spam: "bg-amber-500/10 border-amber-500/20 text-amber-400", default: "bg-muted border-border text-muted-foreground" };
  return (
    <div className="space-y-4">
      <div><p className="text-sm font-semibold">Moderation Queue</p><p className="font-pixel text-muted-foreground mt-0.5">{flags.length} pending</p></div>
      {loading ? <Skeleton className="h-32 rounded-xl" /> : flags.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-12 text-center"><Shield size={24} className="text-emerald-500/40 mx-auto mb-3" /><p className="font-pixel text-muted-foreground">Queue is clear</p></div>
      ) : (
        <div className="rounded-xl border border-border overflow-hidden">
          {flags.map((f, i) => (
            <div key={f.id} className={`px-4 py-3.5 hover:bg-muted/20 transition-colors ${i < flags.length - 1 ? "border-b border-border/60" : ""}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                    <span className={`font-pixel px-2 py-0.5 rounded-full border ${reasonColors[f.reason] ?? reasonColors.default}`}>{f.reason}</span>
                    <span className="font-pixel text-muted-foreground capitalize">{f.content_type.replace("_", " ")}</span>
                    <span className="font-pixel text-muted-foreground/40">{fmtDate(f.created_at)} · {fmtTime(f.created_at)}</span>
                  </div>
                  <p className="font-pixel text-muted-foreground/40 truncate">{f.content_id}</p>
                </div>
                <div className="flex gap-1.5 shrink-0">
                  <Btn onClick={() => dismiss(f.id)} variant="ghost">Dismiss</Btn>
                  <Btn onClick={() => remove(f.id)} variant="danger"><Trash2 size={11} />Remove</Btn>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Network ─────────────────────────────────────────────────────────────
function Network({ status, onRefresh }: { status: Status | null; onRefresh: () => void }) {
  const [refreshing, setRefreshing] = useState(false);
  async function refreshIP() {
    setRefreshing(true);
    try { const res = await api.refreshIP(); toast.success(res.changed ? `IP updated: ${res.ip}` : `Unchanged: ${res.ip}`); onRefresh(); }
    catch (e: unknown) { toast.error(e instanceof Error ? e.message : "Failed"); } finally { setRefreshing(false); }
  }
  if (!status) return <Skeleton className="h-48 rounded-xl" />;
  const ports = [
    { name: "API / Dashboard", port: status.ports.http, protocol: "HTTP", desc: "REST + WebSocket" },
    { name: "PeerJS Signaling", port: status.ports.peerjs, protocol: "HTTP+WS", desc: "WebRTC signaling" },
    { name: "STUN / TURN", port: status.ports.turn, protocol: "TCP+UDP", desc: "NAT traversal" },
    { name: "TURN TLS", port: status.ports.turnTLS, protocol: "TLS", desc: "Encrypted relay" },
  ];
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="font-pixel text-muted-foreground mb-3">Network Identity</p>
            <div className="space-y-2.5">
              {[{ label: "Public IP", value: status.network.publicIP }, { label: "Local IP", value: status.network.localIP }, { label: "Last Checked", value: fmtDate(status.network.lastSeen) }].map(({ label, value }) => (
                <div key={label} className="flex items-center gap-4">
                  <span className="font-pixel text-muted-foreground w-24">{label}</span>
                  <span className="font-pixel text-foreground">{value}</span>
                </div>
              ))}
            </div>
          </div>
          <Button onClick={refreshIP} disabled={refreshing} variant="outline" size="sm" className="h-8 px-3 font-pixel gap-1.5">
            <RefreshCw size={11} className={refreshing ? "animate-spin" : ""} />{refreshing ? "Checking…" : "Refresh"}
          </Button>
        </div>
      </div>
      <div className="rounded-xl border border-border overflow-hidden">
        {ports.map((p, i) => (
          <div key={p.port} className={`flex items-center justify-between px-4 py-3 ${i < ports.length - 1 ? "border-b border-border/60" : ""} hover:bg-muted/20 transition-colors`}>
            <div className="flex items-center gap-3">
              <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_6px_rgba(52,211,153,0.5)]" />
              <div><p className="text-xs font-medium text-foreground">{p.name}</p><p className="font-pixel text-muted-foreground">{p.desc}</p></div>
            </div>
            <div className="text-right"><p className="font-pixel text-foreground">{p.port}</p><p className="font-pixel text-muted-foreground/50">{p.protocol}</p></div>
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="font-pixel text-muted-foreground mb-4">Connection Fallback Chain</p>
        <div className="flex items-center gap-1.5 flex-wrap">
          {["Direct P2P", "STUN P2P", "TURN Relay", "REST Polling"].map((step, i, arr) => (
            <div key={step} className="flex items-center gap-1.5">
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2"><p className="font-pixel text-foreground">{step}</p></div>
              {i < arr.length - 1 && <ChevronRight size={12} className="text-muted-foreground/40" />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── App Shell ───────────────────────────────────────────────────────────
export default function Dashboard() {
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [stats, setStats] = useState<Stats | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [pulse, setPulse] = useState(false);
  const ivRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { if (getToken()) setAuthed(true); setLoading(false); }, []);

  const loadData = useCallback(async () => {
    try { const [s, st] = await Promise.all([api.stats(), api.status()]); setStats(s); setStatus(st); setPulse(true); setTimeout(() => setPulse(false), 600); } catch { }
  }, []);

  useEffect(() => {
    if (authed) { loadData(); ivRef.current = setInterval(loadData, 15000); return () => { if (ivRef.current) clearInterval(ivRef.current); }; }
  }, [authed, loadData]);

  if (loading) return null;
  if (!authed) return <Login onLogin={() => setAuthed(true)} />;

  const tabs: { id: Tab; label: string; icon: React.ElementType; badge?: number }[] = [
    { id: "overview",     label: "Overview",     icon: LayoutGrid },
    { id: "games",        label: "Games",        icon: Gamepad2 },
    { id: "newsletters",  label: "Newsletter",   icon: Newspaper },
    { id: "users",        label: "Users",        icon: Users },
    { id: "projects",     label: "Projects",     icon: Box },
    { id: "moderation",   label: "Moderation",   icon: Shield, badge: stats?.pendingFlags },
    { id: "network",      label: "Network",      icon: Globe },
  ];

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border/60 bg-background/95 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-5 h-12 flex items-center justify-between">
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-2.5">
              <AstroLogo size={18} />
              <span className="font-pixel text-[13px] text-foreground">Astro Core</span>
              <span className="font-pixel text-muted-foreground/50 border border-border/60 rounded px-1.5 py-0.5">Admin</span>
            </div>
            <div className="w-px h-4 bg-border" />
            <nav className="flex items-center gap-0.5">
              {tabs.map(t => {
                const Icon = t.icon;
                return (
                  <button key={t.id} onClick={() => setTab(t.id)}
                    className={`font-pixel flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-all ${tab === t.id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"}`}>
                    <Icon size={11} />{t.label}
                    {t.badge ? <span className="ml-0.5 px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-400 text-[10px] font-pixel leading-none">{t.badge}</span> : null}
                  </button>
                );
              })}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full transition-colors ${pulse ? "bg-primary" : "bg-emerald-500"} shadow-[0_0_6px_rgba(52,211,153,0.5)]`} />
              <span className="font-pixel text-muted-foreground">running</span>
            </div>
            <div className="w-px h-3 bg-border" />
            <button onClick={() => { clearToken(); setAuthed(false); setStats(null); setStatus(null); }}
              className="font-pixel text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
              <X size={11} />Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-5 py-7">
        {tab === "overview"    && <Overview stats={stats} status={status} />}
        {tab === "games"       && <Games />}
        {tab === "newsletters" && <Newsletters />}
        {tab === "users"       && <UsersPanel />}
        {tab === "projects"    && <Projects />}
        {tab === "moderation"  && <Moderation />}
        {tab === "network"     && <Network status={status} onRefresh={loadData} />}
      </main>
    </div>
  );
}
