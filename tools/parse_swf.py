#!/usr/bin/env python3
"""解析SWF文件结构，提取sprite帧信息"""
import zlib, struct, sys

def fix_and_parse(filepath):
    data = open(filepath, 'rb').read()
    
    # 找CWS/FWS/ZWS签名（可能有前缀字节）
    for sig in [b'CWS', b'FWS', b'ZWS']:
        idx = data.find(sig)
        if idx != -1:
            break
    else:
        print(f"ERROR: No SWF signature found in {filepath}")
        return None
    
    swf = data[idx:]
    sig_str = swf[:3].decode()
    version = swf[3]
    file_len = struct.unpack('<I', swf[4:8])[0]
    
    if sig_str == 'CWS':
        dobj = zlib.decompressobj()
        body = dobj.decompress(swf[8:])
        body += dobj.flush()
    elif sig_str == 'FWS':
        body = swf[8:]
    else:
        print(f"ZWS (LZMA) not supported")
        return None
    
    # 解析RECT
    nbits = (body[0] >> 3)
    total_bits = 5 + nbits * 4
    rect_bytes = (total_bits + 7) // 8
    pos = rect_bytes
    
    fps = body[pos + 1]
    frame_count = struct.unpack('<H', body[pos+2:pos+4])[0]
    pos += 4
    
    # 遍历tags
    sprite_frames = {}
    tag_count = 0
    while pos < len(body) - 2:
        tag_word = struct.unpack('<H', body[pos:pos+2])[0]
        tag_type = tag_word >> 6
        tag_len = tag_word & 0x3F
        pos += 2
        if tag_len == 0x3F:
            if pos + 4 > len(body):
                break
            tag_len = struct.unpack('<I', body[pos:pos+4])[0]
            pos += 4
        
        if tag_type == 39 and tag_len >= 4:  # DefineSprite
            sprite_id = struct.unpack('<H', body[pos:pos+2])[0]
            sprite_fc = struct.unpack('<H', body[pos+2:pos+4])[0]
            sprite_frames[sprite_id] = sprite_fc
        
        pos += tag_len
        tag_count += 1
        if tag_type == 0 or tag_count > 10000:
            break
    
    return {
        'version': version,
        'fps': fps,
        'main_frames': frame_count,
        'width': 0,  # TODO: parse RECT properly
        'height': 0,
        'sprites': sprite_frames,
        'max_sprite_frames': max(sprite_frames.values()) if sprite_frames else 0,
    }

if __name__ == '__main__':
    fp = sys.argv[1] if len(sys.argv) > 1 else '/Users/Apple/Desktop/QC宠物素材/动画SWF/GG/Adult/peaceful/Stand.swf'
    info = fix_and_parse(fp)
    if info:
        print(f"SWF v{info['version']}, FPS={info['fps']}, Main frames={info['main_frames']}")
        print(f"Sprites: {len(info['sprites'])}, Max sprite frames: {info['max_sprite_frames']}")
        for sid, fc in sorted(info['sprites'].items()):
            if fc > 1:
                print(f"  Sprite #{sid}: {fc} frames")
