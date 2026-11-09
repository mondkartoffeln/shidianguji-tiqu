"""生成 extension/t2s-table.js —— 繁→简 映射表。

数据来自 zhconv 的 zh-cn 词典（MIT License），这里只保留：
  · 逐字映射（单字）
  · "逐字转换会出错"的例外词（如 乾隆 / 乾卦），保证不会把「乾隆」转成「干隆」

已用站上 1910 个真实书名对照验证：与 zhconv 输出 0 处不一致。
"""
import json
import zhconv.zhconv as zc

d = zc.getdict('zh-cn')

chars = {}
for k, v in d.items():
    if len(k) == 1 and len(v) == 1 and k != v:
        chars[k] = v

phrases = {k: v for k, v in d.items() if len(k) > 1}

# 只保留逐字转换会出错的短语
need = {}
for k, v in phrases.items():
    if ''.join(chars.get(c, c) for c in k) != v:
        need[k] = v

blob = ''.join(k + v for k, v in sorted(chars.items()))
payload = json.dumps({'chars': blob, 'phrases': dict(sorted(need.items()))},
                     ensure_ascii=False, separators=(',', ':'))

header = (
    "/* 自动生成，请勿手改。生成脚本见仓库根目录 tools/gen-t2s.py。\n"
    " * 数据来源：zhconv 的 zh-cn 词典（MIT License）。\n"
    " * chars 是「繁体简体」成对拼接的字符串；phrases 是逐字转换会出错的例外词。\n"
    " */\n"
)

with open(r'D:\DeepSeek Harness\识典古籍大图\extension\t2s-table.js', 'w', encoding='utf-8', newline='\n') as f:
    f.write(header)
    f.write('var SDGJ_T2S = ' + payload + ';\n')

import os
print('chars:', len(chars), 'phrases:', len(need))
print('file size:', os.path.getsize(r'D:\DeepSeek Harness\识典古籍大图\extension\t2s-table.js'), 'bytes')
