/** In-memory stand-ins for Workers KV, a Durable Object namespace and the GitHub REST API. No network access. */

import { DbRateLimiter } from '../src/db-limiter'
import { fromBase64, toBase64 } from '../src/github'

/**
 * The DB_LIMITS namespace: one DbRateLimiter per name over an in-memory storage. Like a real Durable Object, it
 * handles one request at a time (each waits for the one before it), however many arrive at once.
 */
export class FakeDbLimits {
  /** The storage of the one object the relay uses (key -> value). */
  readonly data = new Map<string, unknown>()
  /** Every request's op, in order. */
  readonly ops: string[] = []
  /** Make every request fail with this status. */
  failWith: number | null = null
  private readonly object: DbRateLimiter
  private queue: Promise<unknown> = Promise.resolve()

  constructor() {
    const data = this.data
    // Every storage call yields first, as a real one does, so unserialised requests would interleave.
    const storage = {
      get: async (key: string) => {
        await Promise.resolve()
        return data.get(key)
      },
      put: async (key: string, value: unknown) => {
        await Promise.resolve()
        data.set(key, value)
      },
      deleteAll: async () => {
        await Promise.resolve()
        data.clear()
      }
    }
    this.object = new DbRateLimiter({ storage } as unknown as DurableObjectState)
  }

  asNamespace(): DurableObjectNamespace {
    const stub = {
      fetch: (input: string, init?: RequestInit): Promise<Response> => {
        const run = async (): Promise<Response> => {
          const request = new Request(input, init)
          this.ops.push(((await request.clone().json()) as { op: string }).op)
          if (this.failWith !== null) return new Response('failed', { status: this.failWith })
          return this.object.fetch(request)
        }
        const next = this.queue.then(run, run)
        this.queue = next.catch(() => undefined)
        return next
      }
    }
    return {
      idFromName: (name: string) => ({ name }),
      get: () => stub
    } as unknown as DurableObjectNamespace
  }

  /** The counter keys stored now. */
  keys(): string[] {
    return [...this.data.keys()]
  }
}

export class FakeKV {
  readonly data = new Map<string, string>()
  readonly puts: { key: string; ttl?: number }[] = []
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null
  }
  async put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> {
    this.data.set(key, value)
    this.puts.push({ key, ttl: opts?.expirationTtl })
  }
  asKV(): KVNamespace {
    return this as unknown as KVNamespace
  }
}

/** Where the metadata repository's API lives: the only repository this GitHub has. */
const PREFIX = '/repos/jeremybris/PlayOut-metadata'

/** The branch the PlayOut database lives on, in the metadata repository. */
export const DB_BRANCH = 'database'

export interface Pull {
  number: number
  title: string
  head: string
  base: string
  body: string
  labels: string[]
  /** 'open' when missing. */
  state?: 'open' | 'closed'
  /** The head branch lives in someone's fork (`head` is then that fork's branch, not one here). */
  fork?: boolean
  /** Who opened it; the relay's app (a bot) when missing. */
  user?: { login: string; type: string }
  /** Comments posted on it, in order. */
  comments?: string[]
}

/** A commit: its files, and its parents (none for a branch's first commit; two for a merge). */
interface Commit {
  files: Map<string, string>
  parents: string[]
}

export interface Call {
  method: string
  path: string
  body?: unknown
  auth: string | null
  /**
   * The branch the call reads or writes: a contents read's ref (GitHub's default, main, when none is named), a
   * contents write's branch (main when none is named, as GitHub does), the branch a ref call names, a pull request's
   * head; undefined for calls about no branch (listing pull requests, labels).
   */
  branch?: string
}

interface CallBody {
  ref?: string
  sha?: string
  branch?: string
  content?: string
  head?: string
  labels?: string[]
  force?: boolean
  base_tree?: string
  tree?: string | { path: string; content: string }[]
  parents?: string[]
  body?: string
  state?: 'open' | 'closed'
  title?: string
}

/**
 * A tiny GitHub with one repository, jeremybris/PlayOut-metadata, as the relay sees it: its branches -> files (main,
 * the `database` branch the PlayOut database lives on, and any suggest/... branch the relay creates), pull requests
 * and labels. Every call to it is logged in `calls`, with the branch it touches; a call to any other repository is
 * answered 404 and logged in `strayCalls`.
 */
export class FakeGitHub {
  readonly branches = new Map<string, { sha: string; files: Map<string, string> }>()
  readonly pulls: Pull[] = []
  readonly calls: Call[] = []
  /** Calls to any repository other than PlayOut-metadata (the relay should never make one). */
  readonly strayCalls: { method: string; url: string }[] = []
  /** Make a request fail: method + path prefix -> status. */
  failures: { method: string; path: string; status: number }[] = []
  /**
   * Other commits that land between the relay's read and its write: before each contents write, the first one left
   * is taken out and run on the target branch's files (so the relay's sha is stale and GitHub refuses the write).
   */
  races: ((files: Map<string, string>) => void)[] = []
  /**
   * What GitHub answers a write with a stale sha: by default 409 for a sha that does not match and 422 for a sha sent
   * for a missing file; set it to answer both with one status.
   */
  staleStatus: number | null = null
  /** Answer reads as GitHub does for files over 1 MB: no inline content, only the raw media type has it. */
  largeFiles = false
  /**
   * Runs before each call is answered (after it is logged): a test's way to let something else happen on GitHub at
   * that moment, such as another request's pull request.
   */
  onCall: ((method: string, path: string) => void | Promise<void>) | null = null
  /**
   * Who the relay is signed in as: the pull requests it opens are this user's. Unset, the app's bot (as with a
   * GitHub App); set it to a user for a relay running on GITHUB_TOKEN.
   */
  author: { login: string; type: string } | null = null
  /** Every commit by sha (a branch's live files win for its current sha: tests change them in place). */
  private readonly commits = new Map<string, Commit>()
  private readonly trees = new Map<string, Map<string, string>>()
  private nextSha = 1

  /** `files` are main's; the database branch starts empty (created from database-repo/, no data yet). */
  constructor(files: Record<string, string> = {}) {
    this.branches.set('main', this.commit(new Map(Object.entries(files)), null))
    this.branches.set(DB_BRANCH, this.commit(new Map(), null))
  }

  /** A new commit with these files; the branch entry for it. */
  private commit(
    files: Map<string, string>,
    parent: string | null
  ): { sha: string; files: Map<string, string> } {
    const sha = this.sha()
    this.commits.set(sha, { files: new Map(files), parents: parent ? [parent] : [] })
    return { sha, files }
  }

  /** The files of a commit or branch (by name or sha), or undefined. */
  private filesAt(ref: string): Map<string, string> | undefined {
    const named = this.branches.get(ref)
    if (named) return named.files
    for (const b of this.branches.values()) if (b.sha === ref) return b.files
    return this.commits.get(ref)?.files
  }

  /** The sha a branch name or sha stands for. */
  private shaOf(ref: string): string | undefined {
    return this.branches.get(ref)?.sha ?? (this.commits.has(ref) ? ref : undefined)
  }

  /** A commit's ancestors, itself first, nearest first (breadth first through every parent). */
  private ancestors(sha: string): string[] {
    const out: string[] = []
    const queue = [sha]
    while (queue.length > 0) {
      const s = queue.shift()!
      if (out.includes(s)) continue
      out.push(s)
      queue.push(...(this.commits.get(s)?.parents ?? []))
    }
    return out
  }

  /** The parents of the commit a branch points at. */
  parentsOf(branch: string): string[] {
    return this.commits.get(this.branches.get(branch)!.sha)?.parents ?? []
  }

  /** The open pull requests now. */
  openPulls(): Pull[] {
    return this.pulls.filter((p) => (p.state ?? 'open') === 'open')
  }

  /** A pull request as GitHub's API answers it (the fields the relay reads). */
  private rawPull(p: Pull): unknown {
    const head = p.fork ? undefined : this.branches.get(p.head)
    return {
      number: p.number,
      html_url: pullUrl(p.number),
      state: p.state ?? 'open',
      title: p.title,
      body: p.body,
      labels: p.labels.map((name) => ({ name })),
      user: p.user ?? { login: 'playout-metadata[bot]', type: 'Bot' },
      head: {
        ref: p.head,
        sha: head?.sha ?? 'f'.repeat(40),
        repo: { full_name: p.fork ? 'someone/PlayOut-metadata' : 'jeremybris/PlayOut-metadata' }
      },
      base: { ref: p.base }
    }
  }

  /** Someone else's commit on a branch (the owner merging or editing on main, say): one file set to `text`. */
  commitTo(branch: string, path: string, text: string): void {
    const b = this.branches.get(branch)!
    b.files.set(path, text)
    b.sha = this.commit(b.files, b.sha).sha
  }

  /** The files of the database branch. */
  get dbFiles(): Map<string, string> {
    return this.branches.get(DB_BRANCH)!.files
  }

  /** The text of a file on the database branch (undefined when it does not exist). */
  dbFile(path: string): string | undefined {
    return this.dbFiles.get(path)
  }

  /** Every call that read or wrote the database branch, in order. */
  get dbCalls(): Call[] {
    return this.calls.filter((c) => c.branch === DB_BRANCH)
  }

  /** Every call that was not a read (a commit, a ref created or deleted, a pull request, a label). */
  writes(): Call[] {
    return this.calls.filter((c) => c.method !== 'GET')
  }

  /** The suggest/... branches there are now. */
  suggestBranches(): string[] {
    return [...this.branches.keys()].filter((b) => b.startsWith('suggest/'))
  }

  private sha(): string {
    return (this.nextSha++).toString(16).padStart(40, '0')
  }

  private blobSha(text: string): string {
    let h = 0
    for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0
    return h.toString(16).padStart(40, 'b')
  }

  /** The branch a call touches (see Call.branch). */
  private branchOf(
    method: string,
    path: string,
    url: URL,
    body: CallBody | undefined
  ): string | undefined {
    const ref = path.match(/^\/git\/refs?\/heads\/(.+)$/)
    if (ref) return ref[1]
    if (method === 'POST' && path === '/git/refs') {
      return String(body?.ref ?? '').replace(/^refs\/heads\//, '')
    }
    if (path.startsWith('/contents/')) {
      return method === 'GET' ? (url.searchParams.get('ref') ?? 'main') : (body?.branch ?? 'main')
    }
    if (method === 'POST' && path === '/pulls') return body?.head
    return undefined
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : (input as Request).url)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    const body = (init?.body ? JSON.parse(String(init.body)) : undefined) as CallBody | undefined
    if (url.origin !== 'https://api.github.com' || !url.pathname.startsWith(`${PREFIX}/`)) {
      this.strayCalls.push({ method, url: url.toString() })
      return reply(404, { message: 'Not Found' })
    }
    const path = decodeURIComponent(url.pathname.slice(PREFIX.length))
    this.calls.push({
      method,
      path,
      body,
      auth: headers.get('Authorization'),
      branch: this.branchOf(method, path, url, body)
    })
    await this.onCall?.(method, path)
    const failure = this.failures.find((f) => f.method === method && path.startsWith(f.path))
    if (failure) return reply(failure.status, { message: 'forced failure' })

    let m: RegExpMatchArray | null
    if (method === 'GET' && (m = path.match(/^\/git\/ref\/heads\/(.+)$/))) {
      const b = this.branches.get(m[1])
      return b ? reply(200, { object: { sha: b.sha } }) : reply(404, { message: 'Not Found' })
    }
    if (method === 'GET' && (m = path.match(/^\/contents\/(.+)$/))) {
      const text = this.filesAt(url.searchParams.get('ref') ?? 'main')?.get(m[1])
      if (text === undefined) return reply(404, { message: 'Not Found' })
      if ((headers.get('Accept') ?? '').includes('raw')) {
        return new Response(text, { status: 200, headers: { 'Content-Type': 'text/plain' } })
      }
      const sha = this.blobSha(text)
      return this.largeFiles
        ? reply(200, { type: 'file', content: '', encoding: 'none', sha })
        : reply(200, { type: 'file', content: toBase64(text), encoding: 'base64', sha })
    }
    if (method === 'POST' && path === '/git/refs') {
      const name = String(body?.ref).replace(/^refs\/heads\//, '')
      if (this.branches.has(name)) return reply(422, { message: 'Reference already exists' })
      const from = this.filesAt(String(body?.sha))
      if (!from) return reply(422, { message: 'Object does not exist' })
      this.branches.set(name, this.commit(new Map(from), String(body?.sha)))
      return reply(201, { ref: body?.ref })
    }
    if (method === 'PATCH' && (m = path.match(/^\/git\/refs\/heads\/(.+)$/))) {
      const b = this.branches.get(m[1])
      const to = this.filesAt(String(body?.sha))
      if (!b || !to) return reply(422, { message: 'Reference does not exist' })
      if (!body?.force && !this.ancestors(String(body?.sha)).includes(b.sha)) {
        return reply(422, { message: 'Update is not a fast forward' })
      }
      b.sha = String(body?.sha)
      b.files = new Map(to)
      return reply(200, { object: { sha: b.sha } })
    }
    if (method === 'GET' && (m = path.match(/^\/git\/commits\/([0-9a-f]{40})$/))) {
      const files = this.filesAt(m[1])
      if (!files) return reply(404, { message: 'Not Found' })
      const tree = this.sha()
      this.trees.set(tree, new Map(files))
      const parents = this.commits.get(m[1])?.parents ?? []
      return reply(200, {
        sha: m[1],
        tree: { sha: tree },
        parents: parents.map((sha) => ({ sha }))
      })
    }
    if (method === 'POST' && path === '/git/trees') {
      const from = this.trees.get(String(body?.base_tree))
      if (!from || !Array.isArray(body?.tree)) return reply(422, { message: 'Invalid tree' })
      const files = new Map(from)
      for (const e of body.tree) files.set(e.path, e.content)
      const sha = this.sha()
      this.trees.set(sha, files)
      return reply(201, { sha })
    }
    if (method === 'POST' && path === '/git/commits') {
      const files = this.trees.get(String(body?.tree))
      const parents = body?.parents ?? []
      if (!files || parents.length === 0 || !parents.every((p) => this.commits.has(p)))
        return reply(422, { message: 'Invalid commit' })
      const sha = this.sha()
      this.commits.set(sha, { files: new Map(files), parents })
      return reply(201, { sha })
    }
    if (method === 'GET' && (m = path.match(/^\/compare\/(.+)\.\.\.(.+)$/))) {
      const a = this.shaOf(m[1])
      const b = this.shaOf(m[2])
      if (!a || !b) return reply(404, { message: 'Not Found' })
      const fromA = new Set(this.ancestors(a))
      const base = this.ancestors(b).find((s) => fromA.has(s))
      if (!base) return reply(404, { message: 'No common ancestor' })
      return reply(200, { merge_base_commit: { sha: base } })
    }
    if (method === 'DELETE' && (m = path.match(/^\/git\/refs\/heads\/(.+)$/))) {
      return this.branches.delete(m[1]) ? new Response(null, { status: 204 }) : reply(422, {})
    }
    if (method === 'PUT' && (m = path.match(/^\/contents\/(.+)$/))) {
      // GitHub writes the default branch when none is named.
      const b = this.branches.get(body?.branch ?? 'main')
      if (!b) return reply(404, { message: 'Branch not found' })
      this.races.shift()?.(b.files)
      const existing = b.files.get(m[1])
      if (existing !== undefined && body?.sha !== this.blobSha(existing)) {
        return reply(this.staleStatus ?? 409, { message: 'sha does not match' })
      }
      if (existing === undefined && body?.sha) {
        return reply(this.staleStatus ?? 422, { message: 'sha for a missing file' })
      }
      b.files.set(m[1], fromBase64(String(body?.content ?? '')))
      b.sha = this.commit(b.files, b.sha).sha
      return reply(existing === undefined ? 201 : 200, { content: { path: m[1] } })
    }
    if (method === 'GET' && path === '/pulls') {
      // The open ones (the relay asks for state=open), newest first as GitHub lists them; pages of per_page.
      const per = Number(url.searchParams.get('per_page') ?? '30')
      const page = Number(url.searchParams.get('page') ?? '1')
      return reply(
        200,
        this.openPulls()
          .sort((a, b) => b.number - a.number)
          .slice((page - 1) * per, page * per)
          .map((p) => this.rawPull(p))
      )
    }
    if (method === 'POST' && path === '/pulls') {
      if (this.openPulls().some((p) => p.head === body?.head && !p.fork)) {
        return reply(422, { message: 'A pull request already exists' })
      }
      const pull: Pull = {
        number: Math.max(0, ...this.pulls.map((p) => p.number)) + 1,
        labels: [],
        ...(body as Partial<Pull>),
        ...(this.author ? { user: { ...this.author } } : {})
      } as Pull
      this.pulls.push(pull)
      return reply(201, this.rawPull(pull))
    }
    if (method === 'GET' && (m = path.match(/^\/pulls\/(\d+)$/))) {
      const pull = this.pulls.find((p) => p.number === Number(m![1]))
      return pull ? reply(200, this.rawPull(pull)) : reply(404, { message: 'Not Found' })
    }
    if (method === 'PATCH' && (m = path.match(/^\/pulls\/(\d+)$/))) {
      const pull = this.pulls.find((p) => p.number === Number(m![1]))
      if (!pull) return reply(404, { message: 'Not Found' })
      if (body?.body !== undefined) pull.body = body.body
      if (body?.title !== undefined) pull.title = body.title
      if (body?.state !== undefined) pull.state = body.state
      return reply(200, this.rawPull(pull))
    }
    if (method === 'POST' && (m = path.match(/^\/issues\/(\d+)\/comments$/))) {
      const pull = this.pulls.find((p) => p.number === Number(m![1]))
      if (!pull) return reply(404, { message: 'Not Found' })
      pull.comments = [...(pull.comments ?? []), String(body?.body ?? '')]
      return reply(201, { id: pull.comments.length })
    }
    if (method === 'POST' && (m = path.match(/^\/issues\/(\d+)\/labels$/))) {
      const pull = this.pulls.find((p) => p.number === Number(m![1]))
      if (!pull) return reply(404, {})
      const labels = body?.labels ?? []
      pull.labels.push(...labels)
      return reply(
        200,
        labels.map((name) => ({ name }))
      )
    }
    return reply(404, { message: 'Not Found' })
  }
}

function pullUrl(n: number): string {
  return `https://github.com/jeremybris/PlayOut-metadata/pull/${n}`
}

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}
