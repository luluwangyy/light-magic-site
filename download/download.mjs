const zh={
 skip:'跳到下载',rehearsal:'浏览器排练',title:'把 Light Magic\n带到另一台电脑。',
 intro:'完整的本地控制器：手势、语音和真实 Eos 灯光控制。Mac 和 Windows 下载同一个文件包。',
 download:'下载 Light Magic',account:'不需要 GitHub 账号，也不需要 clone。下载后请先完整解压。',
 start:'新电脑首次使用',extractTitle:'下载并完整解压',
 extract:'保存 ZIP 文件，把整个 Light-Magic 文件夹解压到“文稿”或其他可写入的位置。文件夹里的 START HERE.html 可以离线查看这些步骤。',
 pythonTitle:'安装一次 Python 3.12',python:'如果电脑已经安装了 64 位 Python 3.12，可以跳过。选择适合你电脑的官方安装程序，安装完成后再继续。',
 macPython:'安装 Python · Mac ↗',windowsPython:'安装 Python · Windows ↗',
 pythonDetail:'Mac 安装包适用于 Intel 和 Apple 芯片。Windows 安装包适用于 64 位 Intel / AMD 电脑。Python 需要单独安装，不包含在 Light Magic 的 ZIP 中。',
 setupTitle:'打开首次设置脚本',setup:'双击适合这台电脑的文件。首次保持联网，并保留弹出的窗口；它会自动安装语音依赖，然后打开控制器。',
 macHelp:'如果 macOS 无法打开 .command 文件，在解压后的文件夹中打开终端，运行：sh "Set up Light Magic.command"。',
 openTitle:'打开本地控制器',open:'在这台电脑上使用 Chrome 或 Edge，打开 ',
 live:'先用 Start rehearsal 检查识别。要控制真实灯光，把这台电脑通过以太网连接到 Eos，填写控制台 IP 并确认会话，然后 Go live。',
 returnTitle:'以后再用',return:'Mac 打开 Start Movement Gesture.command；Windows 打开 Start Movement Gesture.bat。安装好的模型可离线运行，不需要重复设置。',
 includedTitle:'下载包里有什么？',included:'完整程序源码、摄像头识别模型、标准英语语音模型、Movement Lab 3D 预览、Mac 和 Windows 启动脚本，以及离线使用说明。首次设置需要联网安装 Python 语音依赖。较大的 Enhanced 语音模型为可选项，单独安装。',
 savedTitle:'可以带上我现在的 cue 映射吗？',saved:'可以。先关闭两台电脑上的 Light Magic，把原电脑的 profile.json 复制到新 Light-Magic 文件夹。学习过的自定义动作还需复制 custom-motions.json。个人设置不包含在公开下载包里；新电脑上仍需重新确认控制台和设备。',
 browserTitle:'可以不安装，先试试看吗？',browser:'浏览器排练可以直接模拟灯光。要发送真实 Eos 指令，需要在连接控制台的电脑上运行控制器。',
 checksTitle:'版本和下载校验',manifest:'下载清单',source:'源码和完整说明 ↗',back:'返回项目 ↗',
 tested:'Windows 控制器和自动化测试已检查；Mac 真机以及场地的 Eos 连接仍需现场验证。',
};
const elements=[...document.querySelectorAll('[data-copy]')];
const english=new Map(elements.map(element=>[element,element.innerHTML]));
const switcher=document.querySelector('#language');
let language='en',release;
function updateRelease(){
 if(!release)return;
 document.querySelector('#release').textContent=`Mac + Windows · ${(release.bytes/1e6).toFixed(1)} MB · ${language==='zh'?'版本':'Version'} ${release.version}`;
 document.querySelector('#commit').textContent=`${language==='zh'?'程序版本':'Controller version'} ${release.version} · ${release.source_commit.slice(0,7)}`;
 document.querySelector('#checksum').textContent=release.sha256;
}
function setLanguage(next){
 language=next;document.documentElement.lang=next==='zh'?'zh-CN':'en';
 for(const element of elements){
  if(next==='en')element.innerHTML=english.get(element);
  else if(zh[element.dataset.copy]){
   element.textContent=zh[element.dataset.copy];
   if(element.id==='title')element.style.whiteSpace='pre-line';
  }
 }
 switcher.textContent=next==='zh'?'English':'中文';
 switcher.setAttribute('aria-label',next==='zh'?'Switch to English':'切换到中文');
 document.querySelector('#downloadStatus').textContent='';
 updateRelease();
}
switcher.onclick=()=>setLanguage(language==='en'?'zh':'en');
setLanguage(navigator.language?.toLowerCase().startsWith('zh')?'zh':'en');
document.querySelector('#download').addEventListener('click',()=>{
 document.querySelector('#downloadStatus').textContent=language==='zh'?'已发起下载，请查看浏览器的下载列表。完成后先解压，再打开文件夹里的 START HERE.html。':'Download requested. Check your browser’s downloads, then extract the folder and open START HERE.html.';
});
try{
 const response=await fetch('../downloads/release.json',{cache:'no-cache'});
 if(!response.ok)throw Error('Manifest unavailable');
 const metadata=await response.json();
 if(typeof metadata.version==='string'&&Number.isFinite(metadata.bytes)&&metadata.bytes>0&&
    /^[a-f0-9]{64}$/.test(metadata.sha256)&&/^[a-f0-9]{40}$/.test(metadata.source_commit)){
  release=metadata;updateRelease();
 }
}catch{/* The direct download and installation instructions also work without JavaScript metadata. */}
