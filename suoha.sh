#!/bin/bash
# onekey suoha
RUNTIME_DIR="${ARGO_RUNTIME_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)}"
if [ -f "${RUNTIME_DIR}/named-tunnel.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "${RUNTIME_DIR}/named-tunnel.env"
  set +a
fi
linux_os=("Debian" "Ubuntu" "CentOS" "Fedora" "Alpine")
linux_update=("apt update" "apt update" "yum -y update" "yum -y update" "apk update")
linux_install=("apt -y install" "apt -y install" "yum -y install" "yum -y install" "apk add -f")
n=0
for i in `echo ${linux_os[@]}`
do
	if [ $i == $(grep -i PRETTY_NAME /etc/os-release | cut -d \" -f2 | awk '{print $1}') ]
	then
		break
	else
		n=$[$n+1]
	fi
done
if [ $n == 5 ]
then
	echo 当前系统$(grep -i PRETTY_NAME /etc/os-release | cut -d \" -f2)没有适配
	echo 默认使用APT包管理器
	n=0
fi
if [ -z $(type -P unzip) ]
then
	${linux_update[$n]}
	${linux_install[$n]} unzip
fi
if [ -z $(type -P curl) ]
then
	${linux_update[$n]}
	${linux_install[$n]} curl
fi
if [ $(grep -i PRETTY_NAME /etc/os-release | cut -d \" -f2 | awk '{print $1}') != "Alpine" ]
then
	if [ -z $(type -P systemctl) ]
	then
		${linux_update[$n]}
		${linux_install[$n]} systemctl
	fi
fi

xray_binary_ready() {
	[ -f "xray/xray" ] && [ -x "xray/xray" ]
}

cloudflared_ready() {
	[ -f "cloudflared-linux" ] && [ -x "cloudflared-linux" ]
}

download_xray_zip() {
	case "$(uname -m)" in
		x86_64 | x64 | amd64 )
		curl -fsSL https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip -o xray.zip
		;;
		i386 | i686 )
		curl -fsSL https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-32.zip -o xray.zip
		;;
		armv8 | arm64 | aarch64 )
		curl -fsSL https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-arm64-v8a.zip -o xray.zip
		;;
		armv7l )
		curl -fsSL https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-arm32-v7a.zip -o xray.zip
		;;
		* )
		echo 当前架构$(uname -m)没有适配
		return 1
		;;
	esac
}

download_cloudflared_binary() {
	case "$(uname -m)" in
		x86_64 | x64 | amd64 )
		curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared-linux
		;;
		i386 | i686 )
		curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-386 -o cloudflared-linux
		;;
		armv8 | arm64 | aarch64 )
		curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o cloudflared-linux
		;;
		armv7l )
		curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm -o cloudflared-linux
		;;
		* )
		echo 当前架构$(uname -m)没有适配
		return 1
		;;
	esac
}

ensure_xray_binary() {
	if xray_binary_ready; then
		echo "Xray 已存在，跳过下载解压"
		return 0
	fi

	echo "正在下载并解压 Xray..."
	rm -f xray.zip
	download_xray_zip || exit 1
	mkdir -p xray
	unzip -o -d xray xray.zip
	chmod +x xray/xray
	rm -f xray.zip
	xray_binary_ready || { echo "Xray 安装失败"; exit 1; }
}

ensure_cloudflared_binary() {
	if cloudflared_ready; then
		echo "cloudflared 已存在，跳过下载"
		return 0
	fi

	echo "正在下载 cloudflared..."
	rm -f cloudflared-linux
	download_cloudflared_binary || exit 1
	chmod +x cloudflared-linux
	cloudflared_ready || { echo "cloudflared 安装失败"; exit 1; }
}

kill_quick_cloudflared() {
	pkill -9 -f 'cloudflared-linux tunnel --url' >/dev/null 2>&1 || true
}

load_node_session() {
	local session_file="${RUNTIME_DIR}/node-session.json"
	if [ ! -f "$session_file" ] || ! command -v python3 >/dev/null 2>&1; then
		return 1
	fi
	python3 - "$session_file" <<'PY' || return 1
import json, sys
with open(sys.argv[1], encoding="utf-8") as fh:
    data = json.load(fh)
for key in ("uuid", "urlpath", "port"):
    value = str(data.get(key, "")).strip()
    if not value:
        raise SystemExit(1)
    print(value)
PY
}

save_node_session() {
	local session_file="${RUNTIME_DIR}/node-session.json"
	if ! command -v python3 >/dev/null 2>&1; then
		return 0
	fi
	python3 - "$session_file" "$uuid" "$urlpath" "$port" <<'PY'
import json, sys
path, uuid, urlpath, port = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
with open(path, "w", encoding="utf-8") as fh:
    json.dump({"uuid": uuid, "urlpath": urlpath, "port": port}, fh, indent=2)
    fh.write("\n")
PY
}

watch_named_tunnel() {
	local start_script="${RUNTIME_DIR}/start-named-tunnel.sh"
	[ -f "$start_script" ] || start_script="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)/start-named-tunnel.sh"
	[ -f "$start_script" ] || return 0

	(
		while true; do
			pid_file="${RUNTIME_DIR}/named-tunnel.pid"
			running=0
			if [ -f "$pid_file" ]; then
				pid="$(tr -d '\r\n' < "$pid_file" 2>/dev/null || true)"
				if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
					running=1
				fi
			fi
			if [ "$running" -eq 0 ]; then
				echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] 固定隧道已退出，正在重启..." >>"${RUNTIME_DIR}/named-tunnel.log"
				chmod +x "$start_script" 2>/dev/null || true
				ARGO_RUNTIME_DIR="$RUNTIME_DIR" bash "$start_script" >>"${RUNTIME_DIR}/named-tunnel.log" 2>&1 || true
			fi
			sleep 30
		done
	) >/dev/null 2>&1 &
}

function quicktunnel(){
ensure_xray_binary

port="${XRAY_PORT:-10086}"
node_host="${TUNNEL_NODE_HOSTNAME:-${NODE_HOSTNAME:-}}"
use_named_tunnel=0
if [ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ] || [ -n "${CLOUDFLARE_TUNNEL_CREDENTIALS_FILE:-}" ]; then
	use_named_tunnel=1
fi

if [ "$use_named_tunnel" -eq 0 ]; then
	ensure_cloudflared_binary
fi

if [ "$use_named_tunnel" -eq 1 ] && [ -z "$node_host" ]; then
	echo "已启用固定隧道，但未设置 TUNNEL_NODE_HOSTNAME"
	exit 1
fi

uuid=""
urlpath=""
if [ "$use_named_tunnel" -eq 1 ]; then
	if session_lines="$(load_node_session 2>/dev/null)"; then
		uuid="$(echo "$session_lines" | sed -n '1p')"
		urlpath="$(echo "$session_lines" | sed -n '2p')"
		port="$(echo "$session_lines" | sed -n '3p')"
		echo "复用已有节点会话: path=/${urlpath} port=${port}"
	fi
fi

if [ -z "$uuid" ]; then
	uuid=$(cat /proc/sys/kernel/random/uuid)
	urlpath=$(echo "$uuid" | awk -F- '{print $1}')
	if [ "$use_named_tunnel" -eq 0 ]; then
		port=$[$RANDOM % 10000 + 10000]
	fi
fi
ws_path="/${urlpath}"
if [ $protocol == 1 ]
then
cat>xray/config.json<<EOF
{
	"inbounds": [
		{
			"port": $port,
			"listen": "localhost",
			"protocol": "vmess",
			"settings": {
				"clients": [
					{
						"id": "$uuid",
						"alterId": 0
					}
				]
			},
			"streamSettings": {
				"network": "ws",
				"wsSettings": {
					"path": "$ws_path"
				}
			}
		}
	],
	"outbounds": [
		{
			"protocol": "freedom",
			"settings": {}
		}
	]
}
EOF
fi
if [ $protocol == 2 ]
then
cat>xray/config.json<<EOF
{
	"inbounds": [
		{
			"port": $port,
			"listen": "localhost",
			"protocol": "vless",
			"settings": {
				"decryption": "none",
				"clients": [
					{
						"id": "$uuid"
					}
				]
			},
			"streamSettings": {
				"network": "ws",
				"wsSettings": {
					"path": "$ws_path"
				}
			}
		}
	],
	"outbounds": [
		{
			"protocol": "freedom",
			"settings": {}
		}
	]
}
EOF
fi

# 确保xray正常运行
./xray/xray run>/dev/null 2>&1 &
xray_pid=$!
sleep 2
if ! ps -p $xray_pid > /dev/null; then
    echo "Xray启动失败，请检查配置"
    exit 1
fi

argo=""
if [ "$use_named_tunnel" -eq 1 ]; then
	argo="$node_host"
	echo "使用固定节点域名: https://${argo}"
else
# 启动cloudflared并设置超时机制
./cloudflared-linux tunnel --url http://localhost:$port --no-autoupdate --edge-ip-version $ips --protocol http2 >argo.log 2>&1 &
cloudflared_pid=$!
sleep 1

n=0
max_retries=3
retry_count=0
while true
do
    n=$[$n+1]
    echo 等待cloudflare argo生成地址 已等待 $n 秒
    
    if ! ps -p $cloudflared_pid > /dev/null; then
        echo "Cloudflared进程已退出，重新启动"
        ./cloudflared-linux tunnel --url http://localhost:$port --no-autoupdate --edge-ip-version $ips --protocol http2 >argo.log 2>&1 &
        cloudflared_pid=$!
        sleep 1
    fi
    
    argo=$(cat argo.log 2>/dev/null | grep trycloudflare.com | awk 'NR==2{print}' | awk -F// '{print $2}' | awk '{print $1}')
    
    if [ $n -ge 15 ]; then
        n=0
        retry_count=$[$retry_count+1]
        
        if [ $retry_count -ge $max_retries ]; then
            echo "多次尝试后无法获取argo地址，退出"
            kill -9 $xray_pid $cloudflared_pid >/dev/null 2>&1
            exit 1
        fi
        
        echo "argo获取超时，第$retry_count次重试中"
        
        kill_quick_cloudflared
        
        rm -rf argo.log
        ./cloudflared-linux tunnel --url http://localhost:$port --no-autoupdate --edge-ip-version $ips --protocol http2 >argo.log 2>&1 &
        cloudflared_pid=$!
        sleep 1
    elif [ -z "$argo" ]; then
        sleep 1
    else
        # 成功获取argo地址
        rm -rf argo.log
        break
    fi
done
fi

# 确保没有旧的v2ray.txt
rm -f v2ray.txt
touch v2ray.txt

# 从订阅链接获取节点信息并生成v2ray.txt
subscription_url="https://owo.o00o.ooo/sub?uuid=$uuid&encryption=none&security=tls&type=ws&host=$argo&path=$urlpath"

echo "正在生成订阅节点..."

# 下载并解码订阅内容
encoded_content=$(curl -s "$subscription_url")
if [ -z "$encoded_content" ]; then
    echo "获取订阅内容失败，创建默认节点"
    echo "vless://$uuid@$argo:443?encryption=none&security=tls&type=ws&host=$argo&path=/$urlpath#默认节点_TLS" >> v2ray.txt
else
    # Base64解码
    decoded_content=$(echo "$encoded_content" | base64 -d)
    echo "$decoded_content" > all_nodes.tmp
    
    if [ ! -s all_nodes.tmp ]; then
        echo "解码订阅内容失败，创建默认节点"
        echo "vless://$uuid@$argo:443?encryption=none&security=tls&type=ws&host=$argo&path=/$urlpath#默认节点_TLS" >> v2ray.txt
    else
        # 处理带TLS的节点
        grep -E '^vless://' all_nodes.tmp | while read -r line; do
            # 提取URL编码的节点名称并进行URL解码
            encoded_name=$(echo "$line" | awk -F'#' '{print $2}')
            
            # URL解码函数
            urldecode() {
                local url_encoded="${1//+/ }"
                printf '%b' "${url_encoded//%/\\x}"
            }
            
            # URL解码节点名称
            node_name=$(urldecode "$encoded_name")
            
            # 检查节点名称是否包含指定地区
            if echo "$node_name" | grep -qi -E '(日本|香港|新加坡|美国)'; then
                # 提取IP和端口
                ip_port=$(echo "$line" | awk -F'@' '{print $2}' | awk -F'?' '{print $1}')
                # 生成新链接
                new_line="vless://$uuid@$ip_port?encryption=none&security=tls&type=ws&host=$argo&path=/$urlpath#$encoded_name"
                echo "$new_line" >> v2ray.txt
            fi
        done
        
        rm -f all_nodes.tmp
    fi
fi

# 如果没有找到符合条件的节点，添加默认节点
if [ ! -s v2ray.txt ]; then
    echo "未找到符合条件的节点，添加默认节点"
    echo "vless://$uuid@$argo:443?encryption=none&security=tls&type=ws&host=$argo&path=/$urlpath#默认节点_TLS" >> v2ray.txt
fi

if [ "$use_named_tunnel" -eq 1 ]; then
	save_node_session
	watch_pid_file="${RUNTIME_DIR}/named-tunnel-watch.pid"
	watch_running=0
	if [ -f "$watch_pid_file" ]; then
		watch_pid="$(tr -d '\r\n' < "$watch_pid_file" 2>/dev/null || true)"
		if [ -n "$watch_pid" ] && kill -0 "$watch_pid" >/dev/null 2>&1; then
			watch_running=1
		fi
	fi
	if [ "$watch_running" -eq 0 ]; then
		watch_named_tunnel
		echo $! >"$watch_pid_file"
	fi
fi

echo "节点生成完成，以下是可用节点："
cat v2ray.txt
}

# 设置默认参数
mode=1
protocol=2
ips=4

# 清理历史进程（固定隧道 tunnel run 不杀，只杀临时隧道 --url）
if [ $(grep -i PRETTY_NAME /etc/os-release | cut -d \" -f2 | awk '{print $1}') == "Alpine" ]
then
    kill -9 $(ps -ef | grep xray | grep -v grep | awk '{print $1}') >/dev/null 2>&1
else
    kill -9 $(ps -ef | grep xray | grep -v grep | awk '{print $2}') >/dev/null 2>&1
fi
kill_quick_cloudflared

# 清理历史文件
rm -rf v2ray.txt

# 获取ISP信息
isp=$(curl -$ips -s https://speed.cloudflare.com/meta | awk -F\" '{print $26"-"$18"-"$30}' | sed -e 's/ /_/g')

# 执行梭哈模式
quicktunnel
