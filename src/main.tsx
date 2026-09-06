import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

class StorageBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed)
      return (
        <main style={{ padding: 32 }}>
          <h1>InkBridge 无法打开本地副本</h1>
          <p>
            请检查浏览器是否允许网站存储，然后重新打开。不要清除网站数据，以免丢失尚未导出的笔记。
          </p>
        </main>
      );
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StorageBoundary>
      <App />
    </StorageBoundary>
  </React.StrictMode>,
);
