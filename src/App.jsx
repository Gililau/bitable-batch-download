import React, { useEffect, useState, useCallback, useRef } from 'react';
import JSZip from 'jszip';
import { bitable } from '@lark-base-open/js-sdk';

const ATTACHMENT_TYPE = 17;

export default function App() {
  const [table, setTable] = useState(null);
  const [fields, setFields] = useState([]);
  const [selectedFields, setSelectedFields] = useState({});
  const [records, setRecords] = useState([]);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [status, setStatus] = useState({ text: '正在连接飞书…', type: '' });
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [preview, setPreview] = useState([]);
  const [downloading, setDownloading] = useState(false);
  const isMounted = useRef(true);

  useEffect(() => {
    (async () => {
      try {
        await bitable.bridge.waitForConnect();
        const t = await bitable.base.getActiveTable();
        setTable(t);

        const fieldList = await t.getFieldList();
        const attachFields = fieldList.filter(f => f.type === ATTACHMENT_TYPE);
        setFields(attachFields);

        const sel = {};
        attachFields.forEach(f => { sel[f.id] = true; });
        setSelectedFields(sel);

        if (attachFields.length === 0) {
          setStatus({ text: '当前表没有附件字段', type: 'error' });
        } else {
          setStatus({
            text: `找到 ${attachFields.length} 个附件字段：${attachFields.map(f => f.name).join('、')}`,
            type: ''
          });
        }
      } catch (e) {
        setStatus({ text: `连接失败: ${e.message}`, type: 'error' });
      }
    })();
    return () => { isMounted.current = false; };
  }, []);

  const loadRecords = useCallback(async () => {
    if (!table) return;
    setLoadingRecords(true);
    setStatus({ text: '正在扫描记录…', type: '' });
    try {
      const allRecords = [];
      let pageToken;
      while (true) {
        const page = await table.getRecords({ pageSize: 500, pageToken });
        allRecords.push(...page.items);
        if (!page.hasMore) break;
        pageToken = page.pageToken;
      }
      setRecords(allRecords);
      const attachFieldIds = fields.filter(f => selectedFields[f.id]).map(f => f.id);
      let totalFiles = 0;
      for (const r of allRecords) {
        for (const fid of attachFieldIds) {
          const val = await r.getFieldValue(fid);
          if (Array.isArray(val)) totalFiles += val.length;
        }
      }
      setStatus({
        text: `共 ${allRecords.length} 条记录，${totalFiles} 个附件待下载`,
        type: totalFiles > 0 ? '' : 'done'
      });
    } catch (e) {
      setStatus({ text: `扫描失败: ${e.message}`, type: 'error' });
    }
    setLoadingRecords(false);
  }, [table, fields, selectedFields]);

  const handleDownload = useCallback(async () => {
    if (!table) return;
    setDownloading(true);
    setPreview([]);
    const attachFieldIds = fields.filter(f => selectedFields[f.id]).map(f => f.id);
    const statusEl = { current: 0 };

    try {
      // 先列出所有文件
      const fileList = [];
      for (const r of records) {
        for (const fid of attachFieldIds) {
          const val = await r.getFieldValue(fid);
          if (!Array.isArray(val)) continue;
          for (const att of val) {
            const ft = att.fileToken || att.file_token;
            const name = att.name || `file_${ft}`;
            const field = fields.find(f => f.id === fid);
            fileList.push({ fileToken: ft, name, fieldName: field?.name || '附件' });
          }
        }
      }

      if (fileList.length === 0) {
        setStatus({ text: '没有可下载的附件', type: 'done' });
        setDownloading(false);
        return;
      }

      setStatus({ text: `正在下载 ${fileList.length} 个文件并打包 ZIP…`, type: '' });
      setProgress({ current: 0, total: fileList.length });

      // 逐个下载文件
      const zip = new JSZip();
      for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i];
        try {
          const url = `https://open.feishu.cn/open-apis/drive/v1/medias/${f.fileToken}/download`;
          const resp = await bitable.bridge.fetch(url, { method: 'GET' });
          const blob = await resp.blob();
          zip.file(f.name, blob);
          if (isMounted.current) {
            setProgress(p => ({ ...p, current: i + 1 }));
            setPreview(prev => [...prev.slice(-50), `✅ ${f.name}`]);
          }
        } catch (e) {
          if (isMounted.current) {
            setPreview(prev => [...prev.slice(-50), `❌ ${f.name}: ${e.message}`]);
          }
        }
      }

      // 生成 ZIP
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      const tableName = (await table.getMeta())?.name || 'attachments';
      a.download = `${tableName}_附件.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (isMounted.current) {
        setStatus({
          text: `✅ 下载完成：共 ${fileList.length} 个文件，ZIP 大小约 ${(zipBlob.size / 1024 / 1024).toFixed(1)}MB`,
          type: 'done'
        });
        setProgress({ current: 0, total: 0 });
      }
    } catch (e) {
      if (isMounted.current) {
        setStatus({ text: `下载失败: ${e.message}`, type: 'error' });
      }
    }
    setDownloading(false);
  }, [table, fields, selectedFields, records]);

  const toggleField = (fid) => {
    setSelectedFields(prev => ({ ...prev, [fid]: !prev[fid] }));
  };

  return (
    <div className="container">
      <h2>📎 附件批量下载</h2>
      <div className={`status ${status.type}`}>{status.text}</div>

      {fields.length > 0 && (
        <>
          <h3>选择要下载的附件字段：</h3>
          <div className="field-list">
            {fields.map(f => (
              <div key={f.id} className="field-item">
                <input
                  type="checkbox"
                  id={f.id}
                  checked={!!selectedFields[f.id]}
                  onChange={() => toggleField(f.id)}
                />
                <label htmlFor={f.id}>{f.name}</label>
              </div>
            ))}
          </div>

          <div className="actions">
            <button className="btn btn-secondary" onClick={loadRecords} disabled={loadingRecords}>
              {loadingRecords ? '扫描中…' : '🔄 扫描附件'}
            </button>
            <button
              className="btn btn-primary"
              onClick={handleDownload}
              disabled={downloading || records.length === 0 || !Object.values(selectedFields).some(Boolean)}
            >
              {downloading ? '下载中…' : '⬇️ 批量下载并打包 ZIP'}
            </button>
          </div>

          {progress.total > 0 && (
            <div>
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${(progress.current / progress.total) * 100}%` }} />
              </div>
              <div className="stats">{progress.current} / {progress.total}</div>
            </div>
          )}

          {preview.length > 0 && (
            <div>
              <h3>下载记录：</h3>
              <div className="preview-list">
                {preview.slice(-30).map((item, i) => (
                  <div key={i} className="preview-item">{item}</div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
