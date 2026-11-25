/**
 * 颜色选择器模块 - 独立的颜色选择器组件
 * 用于LED显示屏颜色配置
 */

// 颜色选择器变量
let currentColorTarget = null;
let currentColor = '#FF0000';
let isUpdatingSliders = false;

// 常用颜色（包含LED已有颜色）
const basicColors = [
    // LED已有的三色（优先显示）
    '#FF0000', '#67BFE3', '#FFE566',
    // 其他常用色
    '#00FF00', '#0000FF', '#FFFF00',
    '#FF00FF', '#00FFFF', '#FFA500', '#800080',
    '#008000', '#000080', '#800000', '#808000',
    '#C0C0C0', '#FFFFFF'
];

// 初始化颜色选择器
function initColorPicker() {
    injectColorPickerStyles();
    injectColorPickerHTML();
}

// 注入CSS样式
function injectColorPickerStyles() {
    const css = `
        .setting-group input[type="color"] {
            height: 8vw;
            margin-right: 10px;
            border: 1px solid #ddd;
            cursor: pointer;
            flex: 1;
            border-radius: 4px;
        }

        /* 颜色选择器模态窗口样式 */
        .color-picker-modal {
            display: none;
            position: fixed;
            z-index: 10001;
            left: 0;
            top: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0,0,0,0.5);
            animation: fadeIn 0.3s ease-out;
        }

        .color-picker-content {
            background-color: #fefefe;
            margin: 10% auto;
            padding: 0;
            border: 1px solid #888;
            width: 85%;
            max-width: 600px;
            max-height: calc(var(--app-vh, 100vh) * 0.8);
            border-radius: 8px;
            font-family: 'FZH', sans-serif;
            overflow: hidden;
            display: flex;
            flex-direction: column;
        }

        .color-picker-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 15px 20px;
            background-color: #f5f5f5;
            border-bottom: 1px solid #ddd;
            user-select: none;
            -webkit-user-select: none;
            -moz-user-select: none;
            -ms-user-select: none;
        }

        .color-picker-title {
            font-size: 5vw;
            margin: 0;
            color: #333;
            user-select: none;
            -webkit-user-select: none;
            -moz-user-select: none;
            -ms-user-select: none;
        }

        .color-picker-close {
            color: #aaa;
            float: right;
            font-size: 28px;
            font-weight: bold;
            cursor: pointer;
        }

        .color-picker-close:hover,
        .color-picker-close:focus {
            color: black;
            text-decoration: none;
            cursor: pointer;
        }

        .color-picker-body {
            padding: 20px;
            flex: 1;
            overflow-y: auto;
        }

        .color-section {
            margin-bottom: 25px;
        }

        .color-section-title {
            font-size: 4.5vw;
            margin-bottom: 10px;
            color: #444;
            font-weight: bold;
        }

        /* 16色常用色 */
        .basic-colors {
            display: grid;
            grid-template-columns: repeat(8, 1fr);
            gap: 8px;
            margin-bottom: 15px;
        }

        .basic-color-item {
            width: 100%;
            height: 8vw;
            border: 2px solid #ddd;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.2s;
            position: relative;
        }

        .basic-color-item:hover {
            transform: scale(1.05);
            border-color: #333;
        }

        .basic-color-item.selected {
            border-color: #000;
            border-width: 3px;
        }

        .basic-color-item.selected::after {
            content: '✓';
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            color: white;
            font-weight: bold;
            text-shadow: 1px 1px 2px black;
            font-size: 4vw;
        }

        /* 十六进制输入 */
        .hex-section {
            display: flex;
            align-items: center;
            gap: 10px;
            margin-bottom: 15px;
        }

        .hex-label {
            font-size: 4vw;
            color: #666;
            min-width: 20px;
        }

        .hex-input {
            flex: 1;
            height: 8vw;
            padding: 0 10px;
            border: 2px solid #ddd;
            border-radius: 4px;
            font-size: 4vw;
            font-family: monospace;
            text-transform: uppercase;
            background-color: #f9f9f9;
        }

        .hex-input:focus {
            outline: none;
            border-color: #4CAF50;
            background-color: white;
        }

        /* HSV颜色滑块 */
        .hsv-section {
            margin-bottom: 15px;
        }

        .hsv-slider-group {
            margin-bottom: 15px;
        }

        .hsv-slider-label {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 5px;
            font-size: 4vw;
            color: #555;
        }

        .hsv-slider {
            width: 100%;
            height: 6vw;
            -webkit-appearance: none;
            appearance: none;
            border-radius: 3px;
            outline: none;
            cursor: pointer;
        }

        .hsv-slider::-webkit-slider-thumb {
            -webkit-appearance: none;
            appearance: none;
            width: 5vw;
            height: 5vw;
            border-radius: 50%;
            background: #fff;
            border: 2px solid #333;
            cursor: pointer;
            box-shadow: 0 0 3px rgba(0,0,0,0.3);
        }

        .hsv-slider::-moz-range-thumb {
            width: 5vw;
            height: 5vw;
            border-radius: 50%;
            background: #fff;
            border: 2px solid #333;
            cursor: pointer;
            box-shadow: 0 0 3px rgba(0,0,0,0.3);
        }

        #hue-slider {
            background: linear-gradient(to right, 
                #ff0000 0%, #ffff00 16.67%, #00ff00 33.33%, 
                #00ffff 50%, #0000ff 66.67%, #ff00ff 83.33%, #ff0000 100%);
        }

        #saturation-slider {
            background: linear-gradient(to right, #ffffff, #ff0000);
        }

        #brightness-slider {
            background: linear-gradient(to right, #000000, #ffffff);
        }

        /* 颜色预览 */
        .color-preview {
            display: flex;
            align-items: center;
            gap: 15px;
            margin-top: 15px;
            padding: 15px;
            background-color: #f9f9f9;
            border-radius: 6px;
        }

        .preview-box {
            width: 12vw;
            height: 12vw;
            border: 2px solid #ddd;
            border-radius: 6px;
            flex-shrink: 0;
        }

        .preview-info {
            flex: 1;
            font-size: 3.5vw;
            color: #666;
        }

        .color-picker-footer {
            display: flex;
            justify-content: flex-end;
            gap: 15px;
            padding: 15px 20px;
            background-color: #f9f9f9;
            border-top: 1px solid #ddd;
        }

        .color-confirm-btn, .color-cancel-btn {
            padding: 10px 20px;
            border: none;
            border-radius: 4px;
            font-size: 4vw;
            cursor: pointer;
            font-family: 'FZH', sans-serif;
            transition: background-color 0.3s;
        }

        .color-confirm-btn {
            background-color: #4CAF50;
            color: white;
        }

        .color-confirm-btn:hover {
            background-color: #45a049;
        }

        .color-cancel-btn {
            background-color: #f44336;
            color: white;
        }

        .color-cancel-btn:hover {
            background-color: #da190b;
        }
    `;
    
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
}

// 注入HTML结构
function injectColorPickerHTML() {
    const html = `
        <!-- 颜色选择器模态窗口 -->
        <div id="colorPickerModal" class="color-picker-modal">
            <div class="color-picker-content">
                <div class="color-picker-header">
                    <h3 class="color-picker-title">颜色选择器</h3>
                    <span class="color-picker-close" onclick="closeColorPicker()">&times;</span>
                </div>
                
                <div class="color-picker-body">
                    <!-- 常用颜色（包含LED已有颜色） -->
                    <div class="color-section">
                        <div class="color-section-title">常用颜色（含LED预设色）</div>
                        <div class="basic-colors" id="basicColors">
                            <!-- 基础色块将通过JavaScript生成 -->
                        </div>
                    </div>

                    <!-- 十六进制输入 -->
                    <div class="color-section">
                        <div class="color-section-title">十六进制颜色代码</div>
                        <div class="hex-section">
                            <span class="hex-label">#</span>
                            <input type="text" class="hex-input" id="hexColorInput" 
                                   maxlength="6" placeholder="FF0000" 
                                   oninput="updateColorFromHex()" onblur="validateHexColor()">
                        </div>
                    </div>

                    <!-- HSV滑块 -->
                    <div class="color-section">
                        <div class="color-section-title">RGB/HSV 调色板</div>
                        <div class="hsv-section">
                            <div class="hsv-slider-group">
                                <div class="hsv-slider-label">
                                    <span>色调 (H)</span>
                                    <span id="hueValue">0°</span>
                                </div>
                                <input type="range" class="hsv-slider" id="hueSlider" 
                                       min="0" max="360" value="0" oninput="updateColorFromSliders()">
                            </div>
                            
                            <div class="hsv-slider-group">
                                <div class="hsv-slider-label">
                                    <span>饱和度 (S)</span>
                                    <span id="saturationValue">100%</span>
                                </div>
                                <input type="range" class="hsv-slider" id="saturationSlider" 
                                       min="0" max="100" value="100" oninput="updateColorFromSliders()">
                            </div>
                            
                            <div class="hsv-slider-group">
                                <div class="hsv-slider-label">
                                    <span>亮度 (V)</span>
                                    <span id="brightnessValue">100%</span>
                                </div>
                                <input type="range" class="hsv-slider" id="brightnessSlider" 
                                       min="0" max="100" value="100" oninput="updateColorFromSliders()">
                            </div>
                        </div>
                    </div>

                    <!-- 颜色预览 -->
                    <div class="color-preview">
                        <div class="preview-box" id="colorPreview"></div>
                        <div class="preview-info">
                            <div>HEX: <span id="previewHex">#FF0000</span></div>
                            <div>RGB: <span id="previewRgb">255, 0, 0</span></div>
                            <div>HSV: <span id="previewHsv">0°, 100%, 100%</span></div>
                        </div>
                    </div>
                </div>

                <div class="color-picker-footer">
                    <button class="color-confirm-btn" onclick="confirmColorSelection()">确定</button>
                    <button class="color-cancel-btn" onclick="closeColorPicker()">取消</button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', html);
}

// 打开颜色选择器
function openColorPicker(target) {
    // 阻止默认的颜色选择器
    if (event) {
        event.preventDefault();
    }
    
    currentColorTarget = target;
    
    // 获取当前颜色
    const colorInput = document.getElementById(target);
    currentColor = colorInput.value;
    
    // 初始化模态窗口
    initColorPickerModal();
    
    // 显示模态窗口
    const modal = document.getElementById('colorPickerModal');
    modal.style.display = 'block';
    modal.offsetHeight; // 触发重绘
    modal.style.opacity = '1';
}

// 关闭颜色选择器
function closeColorPicker() {
    const modal = document.getElementById('colorPickerModal');
    modal.style.opacity = '0';
    setTimeout(() => {
        modal.style.display = 'none';
    }, 300);
}

// 初始化颜色选择器模态窗口
function initColorPickerModal() {
    // 生成基础颜色
    generateBasicColors();
    
    // 设置当前颜色
    setCurrentColor(currentColor);
}

// 生成基础颜色块
function generateBasicColors() {
    const container = document.getElementById('basicColors');
    container.innerHTML = '';
    
    basicColors.forEach(color => {
        const colorItem = document.createElement('div');
        colorItem.className = 'basic-color-item';
        colorItem.style.backgroundColor = color;
        colorItem.setAttribute('data-color', color);
        
        colorItem.addEventListener('click', function() {
            selectBasicColor(color);
        });
        
        container.appendChild(colorItem);
    });
}

// 选择基础颜色
function selectBasicColor(color) {
    setCurrentColor(color);
    updateBasicColorSelection(color);
}

// 更新基础颜色选中状态
function updateBasicColorSelection(color) {
    const colorItems = document.querySelectorAll('.basic-color-item');
    colorItems.forEach(item => {
        item.classList.remove('selected');
        if (item.getAttribute('data-color') === color) {
            item.classList.add('selected');
        }
    });
}

// 设置当前颜色
function setCurrentColor(color) {
    currentColor = color;
    
    // 更新预览
    updateColorPreview();
    
    // 更新十六进制输入
    const hexInput = document.getElementById('hexColorInput');
    if (hexInput) {
        hexInput.value = color.substring(1).toUpperCase();
    }
    
    // 更新滑块
    if (!isUpdatingSliders) {
        updateSlidersFromColor(color);
    }
    
    // 更新基础颜色选中状态
    updateBasicColorSelection(color);
}

// 更新颜色预览
function updateColorPreview() {
    const preview = document.getElementById('colorPreview');
    const hexSpan = document.getElementById('previewHex');
    const rgbSpan = document.getElementById('previewRgb');
    const hsvSpan = document.getElementById('previewHsv');
    
    if (preview) preview.style.backgroundColor = currentColor;
    if (hexSpan) hexSpan.textContent = currentColor.toUpperCase();
    
    const rgb = hexToRgb(currentColor);
    if (rgbSpan && rgb) rgbSpan.textContent = `${rgb.r}, ${rgb.g}, ${rgb.b}`;
    
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    if (hsvSpan && hsv) hsvSpan.textContent = `${Math.round(hsv.h)}°, ${Math.round(hsv.s)}%, ${Math.round(hsv.v)}%`;
}

// 从十六进制输入更新颜色
function updateColorFromHex() {
    const hexInput = document.getElementById('hexColorInput');
    let value = hexInput.value.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
    
    if (value.length > 6) {
        value = value.substring(0, 6);
    }
    
    hexInput.value = value;
    
    if (value.length === 6) {
        const color = '#' + value;
        setCurrentColor(color);
    }
}

// 验证十六进制颜色
function validateHexColor() {
    const hexInput = document.getElementById('hexColorInput');
    const value = hexInput.value;
    
    if (value.length === 6 && /^[0-9A-Fa-f]{6}$/.test(value)) {
        const color = '#' + value;
        setCurrentColor(color);
    } else {
        // 恢复到当前颜色
        hexInput.value = currentColor.substring(1);
    }
}

// 从滑块更新颜色
function updateColorFromSliders() {
    isUpdatingSliders = true;
    
    const hue = parseInt(document.getElementById('hueSlider').value);
    const saturation = parseInt(document.getElementById('saturationSlider').value);
    const brightness = parseInt(document.getElementById('brightnessSlider').value);
    
    // 更新显示值
    document.getElementById('hueValue').textContent = hue + '°';
    document.getElementById('saturationValue').textContent = saturation + '%';
    document.getElementById('brightnessValue').textContent = brightness + '%';
    
    // 转换HSV到RGB
    const rgb = hsvToRgb(hue, saturation / 100, brightness / 100);
    const color = rgbToHex(rgb.r, rgb.g, rgb.b);
    
    setCurrentColor(color);
    
    // 更新饱和度和亮度滑块的背景
    updateSliderBackgrounds(hue, saturation, brightness);
    
    isUpdatingSliders = false;
}

// 从颜色更新滑块
function updateSlidersFromColor(color) {
    const rgb = hexToRgb(color);
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    
    const hueSlider = document.getElementById('hueSlider');
    const satSlider = document.getElementById('saturationSlider');
    const brightSlider = document.getElementById('brightnessSlider');
    
    if (hueSlider) hueSlider.value = Math.round(hsv.h);
    if (satSlider) satSlider.value = Math.round(hsv.s);
    if (brightSlider) brightSlider.value = Math.round(hsv.v);
    
    const hueValue = document.getElementById('hueValue');
    const satValue = document.getElementById('saturationValue');
    const brightValue = document.getElementById('brightnessValue');
    
    if (hueValue) hueValue.textContent = Math.round(hsv.h) + '°';
    if (satValue) satValue.textContent = Math.round(hsv.s) + '%';
    if (brightValue) brightValue.textContent = Math.round(hsv.v) + '%';
    
    updateSliderBackgrounds(hsv.h, hsv.s, hsv.v);
}

// 更新滑块背景
function updateSliderBackgrounds(hue, saturation, brightness) {
    // 更新饱和度滑块背景
    const satSlider = document.getElementById('saturationSlider');
    if (satSlider) {
        const hueRgb = hsvToRgb(hue, 1, 1);
        const hueColor = rgbToHex(hueRgb.r, hueRgb.g, hueRgb.b);
        satSlider.style.background = `linear-gradient(to right, #ffffff, ${hueColor})`;
    }
    
    // 更新亮度滑块背景
    const brightSlider = document.getElementById('brightnessSlider');
    if (brightSlider) {
        const darkRgb = hsvToRgb(hue, saturation / 100, 0);
        const brightRgb = hsvToRgb(hue, saturation / 100, 1);
        const darkColor = rgbToHex(darkRgb.r, darkRgb.g, darkRgb.b);
        const brightColor = rgbToHex(brightRgb.r, brightRgb.g, brightRgb.b);
        brightSlider.style.background = `linear-gradient(to right, ${darkColor}, ${brightColor})`;
    }
}

// 确认颜色选择
function confirmColorSelection() {
    if (currentColorTarget) {
        // 更新颜色输入框
        const colorInput = document.getElementById(currentColorTarget);
        colorInput.value = currentColor;
        
        // 如果存在LED颜色系统，更新LED颜色配置
        if (typeof ledColors !== 'undefined') {
            switch(currentColorTarget) {
                case 'name-color':
                    ledColors.name = currentColor;
                    break;
                case 'arrow-up-color':
                    ledColors.arrowUp = currentColor;
                    break;
                case 'arrow-down-color':
                    ledColors.arrowDown = currentColor;
                    break;
                case 'text-color':
                    ledColors.text = currentColor;
                    break;
            }
            
            // 更新CSS和显示
            if (typeof updateCSSColors === 'function') updateCSSColors();
            if (typeof updateLedDisplay === 'function') updateLedDisplay();
            if (typeof saveLedSettings === 'function') saveLedSettings();
        }
    }
    
    closeColorPicker();
}

// 颜色转换函数
function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
}

function rgbToHex(r, g, b) {
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
}

function rgbToHsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const diff = max - min;
    
    let h = 0;
    const s = max === 0 ? 0 : diff / max;
    const v = max;
    
    if (diff !== 0) {
        switch (max) {
            case r: h = ((g - b) / diff + (g < b ? 6 : 0)) / 6; break;
            case g: h = ((b - r) / diff + 2) / 6; break;
            case b: h = ((r - g) / diff + 4) / 6; break;
        }
    }
    
    return { h: h * 360, s: s * 100, v: v * 100 };
}

function hsvToRgb(h, s, v) {
    h /= 360;
    
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    
    let r, g, b;
    switch (i % 6) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        case 5: r = v; g = p; b = q; break;
    }
    
    return {
        r: Math.round(r * 255),
        g: Math.round(g * 255),
        b: Math.round(b * 255)
    };
}

// 全局函数导出
window.openColorPicker = openColorPicker;
window.closeColorPicker = closeColorPicker;
window.confirmColorSelection = confirmColorSelection;
window.updateColorFromHex = updateColorFromHex;
window.validateHexColor = validateHexColor;
window.updateColorFromSliders = updateColorFromSliders;

// 初始化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initColorPicker);
} else {
    initColorPicker();
} 