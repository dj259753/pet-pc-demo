#!/usr/bin/env python3
"""
将逐帧 PNG 拼合为精灵表 (Spritesheet)
同时生成 animation-manifest.json 供宠物 App 使用

用法: python3 assemble_spritesheets.py --input <_frames_dir> --output <sprites_dir> [--size 160]
"""
import os, sys, json, glob
from PIL import Image

# 参数解析
frame_size = 160
input_dir = ''
output_dir = ''

args = sys.argv[1:]
i = 0
while i < len(args):
    if args[i] == '--input': input_dir = args[i+1]; i += 2
    elif args[i] == '--output': output_dir = args[i+1]; i += 2
    elif args[i] == '--size': frame_size = int(args[i+1]); i += 2
    else: i += 1

if not input_dir or not output_dir:
    print('Usage: python3 assemble_spritesheets.py --input <_frames_dir> --output <sprites_dir> [--size 160]')
    sys.exit(1)

os.makedirs(output_dir, exist_ok=True)

# 收集所有动画帧目录
anim_dirs = sorted([
    d for d in os.listdir(input_dir) 
    if os.path.isdir(os.path.join(input_dir, d)) and not d.startswith('.')
])

manifest = {}  # animation name → { sheet, frames, speed, frameW, frameH }

print(f'Found {len(anim_dirs)} animations to assemble')

for anim_name in anim_dirs:
    frames_path = os.path.join(input_dir, anim_name)
    frame_files = sorted(glob.glob(os.path.join(frames_path, '*.png')))
    
    if len(frame_files) == 0:
        print(f'  [SKIP] {anim_name}: no frames')
        continue
    
    # 加载所有帧
    frames = []
    for ff in frame_files:
        img = Image.open(ff).convert('RGBA')
        frames.append(img)
    
    if len(frames) == 0:
        print(f'  [SKIP] {anim_name}: empty frames after load')
        continue
    
    # ─── 直接等比缩放到 frame_size（不裁剪，保持原始比例） ───
    processed_frames = []
    raw_w, raw_h = frames[0].size
    for frm in frames:
        if raw_w == frame_size and raw_h == frame_size:
            processed_frames.append(frm)
        else:
            # 等比缩放到 frame_size 内，居中放到透明画布
            scale = min(frame_size / raw_w, frame_size / raw_h)
            new_w = max(1, int(raw_w * scale))
            new_h = max(1, int(raw_h * scale))
            scaled = frm.resize((new_w, new_h), Image.LANCZOS)
            canvas = Image.new('RGBA', (frame_size, frame_size), (0, 0, 0, 0))
            paste_x = (frame_size - new_w) // 2
            paste_y = (frame_size - new_h) // 2
            canvas.paste(scaled, (paste_x, paste_y))
            processed_frames.append(canvas)
    
    frames = processed_frames
    
    # 去除尾部重复帧
    if len(frames) > 2:
        # 检查最后几帧是否和第一帧相同（循环检测）
        while len(frames) > 2:
            last = frames[-1]
            first = frames[0]
            if list(last.getdata()) == list(first.getdata()):
                frames.pop()
            else:
                break
    
    num_frames = len(frames)
    
    # 拼合为水平精灵表
    sheet_width = frame_size * num_frames
    sheet_height = frame_size
    sheet = Image.new('RGBA', (sheet_width, sheet_height), (0, 0, 0, 0))
    
    for idx, frame in enumerate(frames):
        sheet.paste(frame, (idx * frame_size, 0))
    
    # 保存精灵表
    sheet_filename = f'{anim_name}.png'
    sheet_path = os.path.join(output_dir, sheet_filename)
    sheet.save(sheet_path, 'PNG', optimize=True)
    
    # 读取 meta 文件获取源信息
    meta_path = os.path.join(os.path.dirname(input_dir.rstrip('/')), f'{anim_name}.json')
    source_info = ''
    if os.path.exists(meta_path):
        with open(meta_path) as f:
            meta = json.load(f)
            source_info = meta.get('source', '')
    
    # 根据动画类型推断播放速度
    speed = 250  # 默认
    name_lower = anim_name.lower()
    if 'stand' in name_lower:
        speed = 300
    elif 'speak' in name_lower:
        speed = 200
    elif 'eat' in name_lower or 'clean' in name_lower:
        speed = 250
    elif 'sick' in name_lower or 'dying' in name_lower or 'prostrate' in name_lower:
        speed = 400
    elif 'happy' in name_lower:
        speed = 200
    elif 'play' in name_lower or name_lower.startswith('p'):
        speed = 250
    
    manifest[anim_name] = {
        'sheet': anim_name,
        'frames': num_frames,
        'speed': speed,
        'frameW': frame_size,
        'frameH': frame_size,
        'flipX': False,
        'source': source_info,
    }
    
    file_size = os.path.getsize(sheet_path)
    print(f'  [OK] {anim_name}: {num_frames} frames → {sheet_filename} ({file_size//1024}KB)')

# 保存 manifest
manifest_path = os.path.join(output_dir, 'animation-manifest.json')
with open(manifest_path, 'w') as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)

print(f'\nDone! {len(manifest)} spritesheets generated')
print(f'Manifest: {manifest_path}')
