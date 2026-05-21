import React, { useState, useEffect } from 'react';
import { supabase } from './supabaseClient';

const TONE_OPTIONS = [
  { value: '普通モード', label: '普通モード：日常会話' },
  { value: '丁寧モード', label: '丁寧モード：ビジネス敬語' },
  { value: '法務部モード', label: '法務部モード：法的文書風 ⚖️' },
  { value: '武士モード', label: '武士モード：時代劇風 ⚔️' },
  { value: '皮肉モード', label: '皮肉モード：アイロニー 🚬' },
  { value: 'AI秘書モード', label: 'AI秘書モード：データ分析風 📊' },
  { value: '外国人モード', label: '外国人モード：日本語勉強中 🇺🇸' }
];

export default function App() {
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authLoading, setAuthLoading] = useState(false);

  const [tasks, setTasks] = useState([]);
  const [title, setTitle] = useState('');
  const [tone, setTone] = useState('普通モード');
  const [firstNotifyDays, setFirstNotifyDays] = useState(1);
  const [reminderInterval, setReminderInterval] = useState(1);
  const [listFilter, setListFilter] = useState('pending');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
    });

    const {
      data: { subscription }
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (user) {
      fetchTasks();
    }
  }, [user]);

  const fetchTasks = async () => {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .order('created_at', { ascending: false });
    if (!error) setTasks(data ?? []);
  };

  const handleAuth = async (type) => {
    if (!email || !password) return alert('メールアドレスとパスワードを入力してください');
    setAuthLoading(true);

    const { error } =
      type === 'signup'
        ? await supabase.auth.signUp({ email, password })
        : await supabase.auth.signInWithPassword({ email, password });

    if (error) alert(error.message);
    setAuthLoading(false);
  };

  const handleCreateTask = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;

    const { error } = await supabase.from('tasks').insert([
      {
        user_id: user.id,
        title,
        tone,
        first_notify_days: parseInt(firstNotifyDays, 10),
        reminder_interval_days: parseInt(reminderInterval, 10),
        status: 'pending'
      }
    ]);

    if (error) {
      alert(error.message);
    } else {
      setTitle('');
      fetchTasks();
    }
  };

  const toggleTaskStatus = async (id, currentStatus) => {
    const nextStatus = currentStatus === 'pending' ? 'completed' : 'pending';
    const { error } = await supabase
      .from('tasks')
      .update({
        status: nextStatus,
        completed_at: nextStatus === 'completed' ? new Date().toISOString() : null
      })
      .eq('id', id);

    if (!error) fetchTasks();
  };

  const filteredTasks = tasks.filter((t) => t.status === listFilter);

  if (!user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-pink-50 to-indigo-100 flex flex-col justify-center py-12 sm:px-6 lg:px-8">
        <div className="sm:mx-auto sm:w-full sm:max-w-md text-center">
          <h1 className="text-4xl font-extrabold text-indigo-950 tracking-tight">おまかせリマ</h1>
          <p className="mt-2 text-sm text-gray-600 font-medium">
            「頼んだら、忘れていい。」妻のメンタルロードをゼロにするAI催促
          </p>
        </div>

        <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
          <div className="bg-white py-8 px-4 shadow-xl rounded-2xl sm:px-10 border border-gray-100">
            <div className="space-y-5">
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider">
                  メールアドレス
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="mt-1 block w-full rounded-xl border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm p-3 border"
                  placeholder="wife@example.com"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-700 uppercase tracking-wider">
                  パスワード
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="mt-1 block w-full rounded-xl border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm p-3 border"
                  placeholder="••••••••"
                />
              </div>
              <div className="flex space-x-4 pt-2">
                <button
                  type="button"
                  onClick={() => handleAuth('login')}
                  disabled={authLoading}
                  className="w-1/2 flex justify-center py-3 px-4 border border-transparent rounded-xl shadow-md text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 transition duration-200"
                >
                  ログイン
                </button>
                <button
                  type="button"
                  onClick={() => handleAuth('signup')}
                  disabled={authLoading}
                  className="w-1/2 flex justify-center py-3 px-4 border border-gray-300 rounded-xl shadow-sm text-sm font-bold text-gray-700 bg-white hover:bg-gray-50 transition duration-200"
                >
                  新規登録
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-800">
      <nav className="bg-white border-b border-gray-200 sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 h-16 flex justify-between items-center">
          <div className="flex items-center space-x-2">
            <span className="text-xl font-black text-indigo-600 tracking-tight">おまかせリマ</span>
            <span className="bg-indigo-100 text-indigo-800 text-xs px-2 py-0.5 rounded-full font-bold">
              Wife Dashboard
            </span>
          </div>
          <div className="flex items-center space-x-4">
            <span className="text-xs text-gray-500 hidden sm:inline">{user.email}</span>
            <button
              type="button"
              onClick={() => supabase.auth.signOut()}
              className="text-xs font-bold bg-gray-100 hover:bg-gray-200 text-gray-600 py-2 px-3 rounded-lg transition"
            >
              ログアウト
            </button>
          </div>
        </div>
      </nav>

      <main className="max-w-6xl mx-auto px-4 py-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200/80 h-fit">
          <h2 className="text-lg font-bold text-gray-900 mb-4 flex items-center">
            <span className="mr-2">📥</span> 夫へ家事を委任する
          </h2>
          <form onSubmit={handleCreateTask} className="space-y-4">
            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider">
                やってほしいこと
              </label>
              <input
                type="text"
                placeholder="例: お風呂の防カビくん煙剤を焚く"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="mt-1 block w-full border border-gray-300 rounded-xl shadow-sm p-3 text-sm focus:ring-indigo-500 focus:border-indigo-500"
                required
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider">
                AI催促メッセージのトーン
              </label>
              <select
                value={tone}
                onChange={(e) => setTone(e.target.value)}
                className="mt-1 block w-full border border-gray-300 rounded-xl shadow-sm p-3 text-sm bg-white focus:ring-indigo-500 focus:border-indigo-500"
              >
                {TONE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider">
                  初回通知 (日後)
                </label>
                <input
                  type="number"
                  min="0"
                  value={firstNotifyDays}
                  onChange={(e) => setFirstNotifyDays(e.target.value)}
                  className="mt-1 block w-full border border-gray-300 rounded-xl shadow-sm p-3 text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-gray-500 uppercase tracking-wider">
                  催促頻度 (日おき)
                </label>
                <input
                  type="number"
                  min="1"
                  value={reminderInterval}
                  onChange={(e) => setReminderInterval(e.target.value)}
                  className="mt-1 block w-full border border-gray-300 rounded-xl shadow-sm p-3 text-sm"
                />
              </div>
            </div>
            <button
              type="submit"
              className="w-full bg-indigo-600 text-white py-3 rounded-xl hover:bg-indigo-700 font-bold transition shadow-md"
            >
              タスクを登録して忘れる
            </button>
          </form>
        </div>

        <div className="lg:col-span-2 space-y-4">
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-gray-200/80">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-lg font-bold text-gray-900 flex items-center">
                <span className="mr-2">📋</span> 委任中のタスク状態
              </h2>
              <div className="flex bg-gray-100 p-1 rounded-xl">
                <button
                  type="button"
                  onClick={() => setListFilter('pending')}
                  className={`px-3 py-1.5 text-xs font-bold rounded-lg transition ${listFilter === 'pending' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}
                >
                  催促中 ({tasks.filter((t) => t.status === 'pending').length})
                </button>
                <button
                  type="button"
                  onClick={() => setListFilter('completed')}
                  className={`px-3 py-1.5 text-xs font-bold rounded-lg transition ${listFilter === 'completed' ? 'bg-white text-indigo-600 shadow-sm' : 'text-gray-500 hover:text-gray-900'}`}
                >
                  完了分 ({tasks.filter((t) => t.status === 'completed').length})
                </button>
              </div>
            </div>

            {filteredTasks.length === 0 ? (
              <div className="text-center py-12 border-2 border-dashed border-gray-200 rounded-xl">
                <p className="text-sm text-gray-400">表示するタスクがありません。</p>
              </div>
            ) : (
              <div className="space-y-3">
                {filteredTasks.map((task) => (
                  <div
                    key={task.id}
                    className="flex items-center justify-between p-4 bg-gray-50 rounded-xl border border-gray-200/60 hover:border-gray-300 transition"
                  >
                    <div className="space-y-1">
                      <p
                        className={`text-sm font-bold ${task.status === 'completed' ? 'line-through text-gray-400' : 'text-gray-900'}`}
                      >
                        {task.title}
                      </p>
                      <div className="flex items-center space-x-2 text-xs text-gray-400">
                        <span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded font-bold">
                          {task.tone}
                        </span>
                        <span>•</span>
                        <span>
                          催促回数:{' '}
                          <strong className="text-gray-600">{task.notify_count ?? 0}回</strong>
                        </span>
                      </div>
                    </div>
                    <div>
                      <button
                        type="button"
                        onClick={() => toggleTaskStatus(task.id, task.status)}
                        className={`text-xs font-bold px-3 py-2 rounded-lg transition ${task.status === 'completed' ? 'bg-gray-200 text-gray-600 hover:bg-gray-300' : 'bg-green-50 text-green-700 border border-green-200 hover:bg-green-100'}`}
                      >
                        {task.status === 'completed' ? '未完了に戻す' : '手動で完了'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
