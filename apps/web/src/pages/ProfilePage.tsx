import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, type User } from '../api/client';
import { MUNICIPALITIES } from '../municipalities';

const MAX_BYTES = 5 * 1024 * 1024;

export function Avatar({ user, size = 40 }: { user: Pick<User, 'name' | 'avatarUrl'>; size?: number }) {
  const initials = user.name.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');
  return user.avatarUrl
    ? <img className="avatar" src={user.avatarUrl} alt="" width={size} height={size} />
    : <span className="avatar avatar--initials" style={{ width: size, height: size }} aria-hidden="true">{initials}</span>;
}

export function ProfilePage({ user }: { user: User }) {
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(user.name);
  const [municipality, setMunicipality] = useState(user.municipalityIbge ?? '');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_BYTES) { setMsg({ kind: 'error', text: 'A imagem deve ter no máximo 5 MB.' }); return; }
    setUploading(true);
    try {
      await api.uploadAvatar(file);
      setMsg({ kind: 'success', text: 'Foto atualizada.' });
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Falha no envio' });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const download = async () => {
    const data = await api.exportData();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'meus-dados-mobigo.json' });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="page">
      <h1>Meu perfil</h1>
      <section className="card profile-photo">
        <Avatar user={user} size={96} />
        <div>
          <input ref={fileInput} id="avatar" type="file" accept="image/jpeg,image/png,image/webp,image/heic" hidden
            onChange={(e) => upload(e.target.files?.[0])} />
          <button className="btn" onClick={() => fileInput.current?.click()} disabled={uploading}>
            {uploading ? 'Enviando…' : user.avatarUrl ? 'Trocar foto' : 'Inserir foto de perfil'}
          </button>
          {user.avatarUrl && <button className="btn btn--ghost" onClick={() => api.removeAvatar()}>Remover</button>}
          <p className="muted small">JPEG, PNG, WebP ou HEIC até 5 MB. A foto é recortada em quadrado e a localização gravada nela (EXIF) é apagada.</p>
        </div>
      </section>

      <form className="card" onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.updateMe({ name, municipalityIbge: municipality || null });
          setMsg({ kind: 'success', text: 'Dados salvos.' });
        } catch (err) { setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Falha ao salvar' }); }
      }}>
        <label>Nome<input value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={120} required /></label>
        <label>E-mail<input value={user.email} disabled /></label>
        <label>Município
          <select value={municipality} onChange={(e) => setMunicipality(e.target.value)}>
            <option value="">Não informado</option>
            {MUNICIPALITIES.map((m) => <option key={m.ibge} value={m.ibge}>{m.name}</option>)}
          </select>
        </label>
        <button className="btn">Salvar</button>
      </form>
      {msg && <p className={msg.kind} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</p>}

      <section className="card">
        <h2>Privacidade (LGPD)</h2>
        <p>Você pode baixar todos os seus dados ou excluir sua conta a qualquer momento.</p>
        <button className="btn btn--secondary" onClick={download}>Baixar meus dados</button>{' '}
        <button className="btn btn--danger" onClick={async () => {
          if (!confirm('Excluir sua conta apaga definitivamente suas rotas, categorias e links compartilhados. Continuar?')) return;
          await api.deleteAccount();
          navigate('/');
        }}>Excluir minha conta</button>
      </section>
    </main>
  );
}
