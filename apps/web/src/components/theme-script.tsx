export function ThemeScript() {
  const code = "try{var t=localStorage.getItem('theme')||'system';var d=t==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):t;document.documentElement.dataset.theme=d}catch(e){document.documentElement.dataset.theme='dark'}";
  return <script dangerouslySetInnerHTML={{ __html: code }} />;
}
