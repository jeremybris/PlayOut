// The few GitHub REST calls the owner's PlayOut makes on jeremybris/PlayOut-metadata with the fine-grained token
// (Settings › Metadata › Cloud metadata): check the token, read and write games/<key>.json, list the open suggestions
// and merge or close them. The token only ever travels in the Authorization header: never in a URL, never in a log
// line or an error message.
import { METADATA_REPO } from '../../shared/metadata-cloud'
import { tMain } from '../i18n'

const API = 'https://api.github.com'

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

export interface GitHubClientOptions {
  token: string
  fetch?: typeof fetch
  owner?: string
  repo?: string
  /** Per-request time limit (default 20 s). */
  timeoutMs?: number
}

export interface PullRequestInfo {
  number: number
  url: string
  title: string
  createdAt: string
  labels: string[]
  headSha: string
  /** The base branch commit the pull request was last compared with. */
  baseSha: string
  headRef: string
  /** The head branch lives in the metadata repository itself (the relay's suggest/... branches). */
  headInRepo: boolean
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

export function toBase64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

export function fromBase64(b64: string): string {
  return Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf8')
}

interface RawPull {
  number: number
  html_url: string
  title: string
  created_at: string
  labels?: { name?: string }[]
  head: { sha: string; ref: string; repo?: { full_name?: string } | null }
  base?: { sha?: string }
}

export class GitHubClient {
  private readonly token: string
  private readonly doFetch: typeof fetch
  readonly owner: string
  readonly repo: string
  private readonly timeoutMs: number

  constructor(options: GitHubClientOptions) {
    this.token = options.token
    this.doFetch = options.fetch ?? fetch
    this.owner = options.owner ?? METADATA_REPO.owner
    this.repo = options.repo ?? METADATA_REPO.repo
    this.timeoutMs = options.timeoutMs ?? 20_000
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await this.doFetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'PlayOut',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs)
      })
    } catch (err) {
      throw new GitHubError(
        tMain('mainMetadataCloud.githubUnreachable', { error: (err as Error).message }),
        0
      )
    }
    if (!res.ok) {
      let detail = ''
      try {
        detail = ((await res.json()) as { message?: string }).message ?? ''
      } catch {
        // no JSON body
      }
      throw new GitHubError(
        `GitHub answered ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
        res.status
      )
    }
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  private repoPath(path: string): string {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${path}`
  }

  /** The token's account and whether it may write to the repository. */
  async checkAccess(): Promise<{ login: string; canWrite: boolean }> {
    const user = await this.call<{ login?: string }>('GET', '/user')
    const repo = await this.call<{ permissions?: { push?: boolean; admin?: boolean } }>(
      'GET',
      this.repoPath('')
    )
    return {
      login: user.login ?? '',
      canWrite: repo.permissions?.push === true || repo.permissions?.admin === true
    }
  }

  /** A file's text and blob sha on `ref`; null when it does not exist. */
  async readFile(path: string, ref: string): Promise<{ text: string; sha: string } | null> {
    try {
      const r = await this.call<{ content?: string; encoding?: string; sha: string }>(
        'GET',
        this.repoPath(`/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`)
      )
      if (r.encoding !== 'base64' || typeof r.content !== 'string')
        throw new GitHubError(`GitHub returned ${path} in an unexpected form`, 502)
      return { text: fromBase64(r.content), sha: r.sha }
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null
      throw err
    }
  }

  /** Create or update a file on `branch` (sha = the blob being replaced). */
  async writeFile(opts: {
    path: string
    branch: string
    text: string
    message: string
    sha?: string
  }): Promise<void> {
    await this.call('PUT', this.repoPath(`/contents/${encodePath(opts.path)}`), {
      message: opts.message,
      content: toBase64(opts.text),
      branch: opts.branch,
      ...(opts.sha ? { sha: opts.sha } : {})
    })
  }

  /** Open pull requests carrying `label`, newest first (at most 100). */
  async openPullRequests(label: string): Promise<PullRequestInfo[]> {
    const pulls = await this.call<RawPull[]>(
      'GET',
      this.repoPath('/pulls?state=open&per_page=100&sort=created&direction=desc')
    )
    const full = `${this.owner}/${this.repo}`.toLowerCase()
    return pulls
      .map((p) => ({
        number: p.number,
        url: p.html_url,
        title: p.title,
        createdAt: p.created_at,
        labels: (p.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
        headSha: p.head.sha,
        baseSha: p.base?.sha ?? '',
        headRef: p.head.ref,
        headInRepo: (p.head.repo?.full_name ?? '').toLowerCase() === full
      }))
      .filter((p) => p.labels.includes(label))
  }

  /** The paths a pull request changes (at most 100). */
  async pullRequestFiles(number: number): Promise<string[]> {
    const files = await this.call<{ filename: string }[]>(
      'GET',
      this.repoPath(`/pulls/${number}/files?per_page=100`)
    )
    return files.map((f) => f.filename)
  }

  async pullRequest(number: number): Promise<PullRequestInfo> {
    const p = await this.call<RawPull>('GET', this.repoPath(`/pulls/${number}`))
    const full = `${this.owner}/${this.repo}`.toLowerCase()
    return {
      number: p.number,
      url: p.html_url,
      title: p.title,
      createdAt: p.created_at,
      labels: (p.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
      headSha: p.head.sha,
      baseSha: p.base?.sha ?? '',
      headRef: p.head.ref,
      headInRepo: (p.head.repo?.full_name ?? '').toLowerCase() === full
    }
  }

  /** Merge (squash) a pull request; `sha` = the head the owner reviewed. */
  async mergePullRequest(number: number, sha: string, title: string): Promise<void> {
    await this.call('PUT', this.repoPath(`/pulls/${number}/merge`), {
      merge_method: 'squash',
      sha,
      commit_title: title
    })
  }

  /** Add a comment to a pull request (its issue thread). */
  async commentOnPullRequest(number: number, body: string): Promise<void> {
    await this.call('POST', this.repoPath(`/issues/${number}/comments`), { body })
  }

  async closePullRequest(number: number): Promise<void> {
    await this.call('PATCH', this.repoPath(`/pulls/${number}`), { state: 'closed' })
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.call('DELETE', this.repoPath(`/git/refs/heads/${encodePath(branch)}`))
  }
}
