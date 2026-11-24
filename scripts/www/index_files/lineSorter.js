/**
 * 线路排序工具
 * 负责对公交线路进行分类和排序
 */

/**
 * 对线路列表进行分类和排序
 * @param {Array} lineList - 原始线路列表
 * @returns {Array} 排序后的线路列表
 */
function sortLineList(lineList) {
    var bList = []; 
    var letterList = []; 
    var numList = []; 
    var youList = []; 
    var huanList = [];
    var otherList = []; 

    // 分类处理
    for (var i = 0; i < lineList.length; i++) {
        var name = lineList[i].name.replace("路", "").toUpperCase();
        var code = lineList[i].code;
        var p = lineList[i].price;
        var dict = { name: name, code: code, price: p, originalName: lineList[i].name };

        var firstChar = name.charAt(0);
        // 检查名称中是否包含"游"字
        if (lineList[i].name.includes("游")) {
            youList.push(dict);
        } else if (lineList[i].name.includes("环")) {
            // 检查名称中是否包含"环"字
            huanList.push(dict);
        } else if (firstChar === "B") {
            bList.push(dict);
        } else if (/[A-Z]/.test(firstChar)) {
            // 字母开头的（包括K等）
            letterList.push(dict);
        } else if (/\d/.test(firstChar)) {
            numList.push(dict);
        } else {
            otherList.push(dict);
        }
    }

    // 数字排序函数
    function sortByNumber(a, b) {
        var aMatch = a.name.match(/\d+/);
        var bMatch = b.name.match(/\d+/);
        
        if (aMatch && bMatch) {
            var aNum = parseInt(aMatch[0]);
            var bNum = parseInt(bMatch[0]);
            return aNum - bNum;
        }
        return a.name.localeCompare(b.name);
    }

    // 对各个分类进行排序
    var sortedBList = bList.sort(sortByNumber);
    var sortedLetterList = letterList.sort(sortByNumber);
    var sortedNumList = numList.sort(sortByNumber);
    var sortedYouList = youList.sort(sortByNumber);
    var sortedHuanList = huanList.sort(sortByNumber);
    var sortedOtherList = otherList.sort((a, b) => {
        return a.name.localeCompare(b.name);
    });

    // 添加定制线路
    var customLine = {
        name: "定制",
        code: "DZ",
        price: 0,
        originalName: "定制"
    };
    sortedOtherList.push(customLine);

    // 合并所有排序后的列表：B开头 -> 字母开头 -> 数字开头 -> 包含游字的 -> 包含环字的 -> 其他未分类
    var sortedLineList = sortedBList.concat(
        sortedLetterList,
        sortedNumList,
        sortedYouList,
        sortedHuanList,
        sortedOtherList
    );

    return sortedLineList;
}

/**
 * 处理线路数据并初始化界面
 * @param {Array} lineList - 原始线路列表
 * @param {Function} getLocation - 获取位置信息的回调函数
 * @returns {Array} 排序后的线路列表
 */
function processLineData(lineList, getLocation) {
    // 获取位置信息
    if (typeof getLocation === 'function') {
        getLocation(lineList);
    }

    // 对线路进行排序
    var sortedLineList = sortLineList(lineList);
    
    // 将线路列表保存到全局变量，供车牌记录系统使用
    window.sortedLineList = sortedLineList;

    return sortedLineList;
}

// 如果在浏览器环境中，将函数暴露到全局作用域
if (typeof window !== 'undefined') {
    window.sortLineList = sortLineList;
    window.processLineData = processLineData;
}

// 如果在Node.js环境中，导出模块
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        sortLineList: sortLineList,
        processLineData: processLineData
    };
} 