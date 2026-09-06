import { useState } from 'react';
import { GitHubClient } from '../github/client';
import type { Workspace } from '../core/types';

export function ConnectDialog({
  workspace,
  onClose,
  onConnect,
}: {
  workspace?: Workspace;
  onClose: () => void;
  onConnect: (owner: string, repo: string, branch: string, token: string) => Promise<void>;
}) {
  const [owner, setOwner] = useState(workspace?.owner === 'local' ? '' : workspace?.owner || '');
  const [repo, setRepo] = useState(workspace?.owner === 'local' ? '' : workspace?.repo || '');
  const [token, setToken] = useState('');
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState(workspace?.branch || 'main');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reset = () => {
    setBranches([]);
    setError('');
  };
  return (
    <div className="modal-backdrop">
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="连接 GitHub 仓库"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');
          try {
            if (!branches.length) {
              const remote = new GitHubClient({
                owner: owner.trim(),
                repo: repo.trim(),
                branch,
                token: token.trim(),
              });
              await remote.validateRepository();
              const available = await remote.listBranches();
              if (!available.length)
                throw new Error('仓库中没有已有分支。请先在电脑上提交一份笔记。');
              setBranches(available);
              setBranch(available.includes(branch) ? branch : available[0]);
            } else await onConnect(owner.trim(), repo.trim(), branch, token.trim());
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : '连接失败，请重试。');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-heading">
          <span className="eyebrow">YOUR NOTES, CONNECTED</span>
          <h2>连接你的笔记库</h2>
          <p>从 GitHub 下载完整笔记，在这里继续书写。</p>
        </div>
        <div className="form-row">
          <label>
            仓库所有者
            <input
              required
              autoComplete="off"
              name="owner"
              value={owner}
              onChange={(event) => {
                setOwner(event.target.value);
                reset();
              }}
              placeholder="你的 GitHub 用户名"
            />
          </label>
          <label>
            仓库名称
            <input
              required
              autoComplete="off"
              name="repository"
              value={repo}
              onChange={(event) => {
                setRepo(event.target.value);
                reset();
              }}
              placeholder="my-notes"
            />
          </label>
        </div>
        <label>
          GitHub Token
          <input
            required
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              reset();
            }}
            placeholder="细粒度 Personal Access Token"
          />
        </label>
        <p className="hint">
          Token 只保存在当前页面内存，刷新后需重新输入。仅授权这个笔记仓库，并将 Contents 权限设为
          Read and write。离线编辑不需要 Token。
        </p>
        {!!branches.length && (
          <>
            <label>
              已有分支
              <select value={branch} onChange={(event) => setBranch(event.target.value)}>
                {branches.map((item) => (
                  <option key={item}>{item}</option>
                ))}
              </select>
            </label>
            <p className="notice">
              仓库和分支的本地数据分别保存。切换后，原工作区未同步的修改会继续保留。写权限以实际同步时
              GitHub 的校验结果为准。
            </p>
          </>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? '正在连接…' : branches.length ? '连接并同步' : '校验并读取分支'}
          </button>
        </div>
      </form>
    </div>
  );
}
