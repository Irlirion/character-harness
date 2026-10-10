import { mkdir, writeFile } from 'node:fs/promises';
export async function configureCodex(home:string,cwd:string){
 await mkdir(home,{recursive:true,mode:0o700});await mkdir(cwd,{recursive:true});
 await writeFile(`${home}/config.toml`,`forced_login_method = "chatgpt"
cli_auth_credentials_store = "file"
web_search = "disabled"
[analytics]
enabled = false
[features]
shell_tool = false
unified_exec = false
apps = false
computer_use = false
browser_use = false
in_app_browser = false
code_mode_host = true
multi_agent = false
view_image = false
skill_search = false
skip_host_skill_discovery = true
`,{mode:0o600});
}
