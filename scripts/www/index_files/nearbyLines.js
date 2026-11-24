/**
 * 邻近线路功能模块
 * 负责获取用户位置、查询邻近站点、创建邻近线路按钮
 */

// 邻近线路管理器
window.nearbyLinesManager = {
    // 模块版本信息
    version: '1.0.0',
    
    // 模块初始化状态
    initialized: false,
    // 初始化邻近线路功能
    init: function(lineList) {
        if (!this.initialized) {
            console.log('邻近线路模块初始化中...');
            this.initialized = true;
        }
        this.getLocation(lineList);
    },

    // 获取用户位置
    getLocation: function(lineList) {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (position) => this.showPosition(position, lineList),
                (error) => {
                    console.error('获取位置失败:', error);
                    this.showLocationError();
                }
            );
        } else {
            console.log("此浏览器不支持地理位置定位");
            this.showLocationError();
        }
    },

    // 显示位置错误
    showLocationError: function() {
        const nearLinesContainer = document.querySelector('.near-lines-container');
        if (nearLinesContainer) {
            nearLinesContainer.innerHTML = '';
            const errorButton = document.createElement('button');
            errorButton.className = 'near-btn';
            errorButton.innerText = '位置获取失败';
            errorButton.disabled = true;
            nearLinesContainer.appendChild(errorButton);
        }
    },

    // 处理位置信息并查询邻近站点
    showPosition: function(position, lineList) {
        const data = {
            "location": {
                "longitude": position.coords.longitude,
                "latitude": position.coords.latitude
            }
        };

        // 保存用户位置用于计算最近站点
        window.userLocation = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude
        };

        // 查询邻近站点
        fetch('http://online.zhcslyg.com/bus/web_awesomed/BusNewService/GetNearbyStationInfo', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        })
        .then(response => response.json())
        .then(data => {
            this.processNearbyStations(data, lineList);
        })
        .catch((error) => {
            console.error('查询邻近站点失败:', error);
            this.showLocationError();
        });
    },

    // 处理邻近站点数据
    processNearbyStations: function(data, lineList) {
        // 过滤并提取站点列表中的线路代码
        const filteredData = data.station_list.map(station => {
            return {
                line: station.line.map(line => line.code)
            };
        });

        const formattedData = JSON.stringify(filteredData)
            .replace(/[\{\}\[\]\"\:]/g, '')
            .replace(/line/g, '');

        const uniqueData = Array.from(new Set(formattedData.split(',')))
            .filter(code => code.trim() !== '') // 过滤空字符串
            .join('\n');

        this.createNearbyLineButtons(uniqueData.split('\n'), lineList);
    },

    // 创建邻近线路按钮
    createNearbyLineButtons: function(nearbyLines, lineList) {
        const nearLinesContainer = document.querySelector('.near-lines-container');
        if (!nearLinesContainer) {
            console.error('邻近线路容器不存在');
            return;
        }

        nearLinesContainer.innerHTML = '';
        let buttonCreated = false;

        // 遍历邻近线路代码
        nearbyLines.forEach(nearbyLineCode => {
            if (!nearbyLineCode.trim()) return; // 跳过空值

            // 在线路列表中查找匹配的线路
            lineList.forEach(line => {
                if (line.code == nearbyLineCode) {
                    const button = this.createNearbyLineButton(line);
                    nearLinesContainer.appendChild(button);
                    buttonCreated = true;
                }
            });
        });

        // 如果没有创建任何按钮，显示无邻近线路提示
        if (!buttonCreated) {
            const noLineButton = document.createElement('button');
            noLineButton.className = 'near-btn';
            noLineButton.innerText = '无邻近线路';
            noLineButton.disabled = true;
            nearLinesContainer.appendChild(noLineButton);
        }
    },

    // 创建单个邻近线路按钮
    createNearbyLineButton: function(line) {
        const button = document.createElement('button');
        button.className = 'near-btn';
        button.innerText = line.name;
        
        button.onclick = () => {
            this.selectNearbyLine(line);
        };

        return button;
    },

    // 选择邻近线路
    selectNearbyLine: function(line) {
        // 切换线路时先终止之前的车来了查询并清除数据
        if (typeof stopChelaileQuery === 'function') {
            stopChelaileQuery();
        }
        if (typeof clearChelaileData === 'function') {
            clearChelaileData();
        }

        const priceInput = document.getElementById("price");
        if (!priceInput) {
            console.error('价格输入框不存在');
            return;
        }

        // 处理线路名称：转为大写，根据规则处理"路"字，并处理特殊线路名称
        let formattedLineName = line.name.toUpperCase();
        
        // 如果是旅游直通车X号线，则精简为旅游X线
        if (formattedLineName.includes('旅游直通车') && formattedLineName.includes('号线')) {
            formattedLineName = formattedLineName.replace('旅游直通车', '旅游').replace('号线', '线');
        } else {
            // 其他情况下删除"直通车"文本
            formattedLineName = formattedLineName.replace('直通车', '');
        }
        
        // 如果线路名称是数字+路+文字格式，则保留"路"字，否则删除"路"字
        if (!/^\d+路.+$/.test(formattedLineName)) {
            formattedLineName = formattedLineName.replace('路', '');
        }

        // 更新全局变量
        global_line_name = formattedLineName;
        var priceValue = parseFloat(line.price) || 0;
        priceInput.value = priceValue.toFixed(2) + "元";
        globalLineId = line.code;

        // 标记用户已选择线路
        if (typeof startupStatus !== 'undefined') {
            startupStatus.userSelected = true;
        }
        
        // 启用反向按钮
        const reverseBtn = document.getElementById("reverse-btn");
        if (reverseBtn) {
            reverseBtn.disabled = false;
        }
        
        // 选择线路后自动展示开往图案区域
        if (typeof ledDisplaySettings !== 'undefined') {
            ledDisplaySettings.showArrow = true;
        }
        const showArrowElement = document.getElementById('show-arrow');
        if (showArrowElement) {
            showArrowElement.checked = true;
        }
        
        // 恢复所有按钮状态
        const buttonIds = ["refresh-btn", "timetable-btn", "first-bus", "bus_online"];
        buttonIds.forEach(id => {
            const button = document.getElementById(id);
            if (button) {
                button.disabled = false;
                button.style.opacity = "1";
            }
        });

        // 刷新线路信息
        if (typeof refresh === 'function') {
            refresh();
        }
    },

    // 刷新邻近线路（当位置改变时调用）
    refresh: function(lineList) {
        if (window.userLocation) {
            this.showPosition({
                coords: {
                    latitude: window.userLocation.latitude,
                    longitude: window.userLocation.longitude
                }
            }, lineList);
        } else {
            this.getLocation(lineList);
        }
    }
};

// 导出模块（兼容不同的模块系统）
if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.nearbyLinesManager;
}

// 模块加载完成时的输出
console.log('邻近线路模块已加载 v' + window.nearbyLinesManager.version); 