// 预设的线路ID映射表（智慧港城线路ID → 车来了上下行ID）
const presetLineMapping = {
    "2201": {
        upLineId: "560295617788660",
        downLineId: "560295617788659",
        lineName: "22K", // 可选：车来了线路名称2201
        lineNo: "560295617788660" // 可选：车来了线路编号
    },
    "23044": {
        upLineId: "560295617788560",
        downLineId: "560295617788559",
        lineName: "旅游直通车1号线",
        lineNo: "560295617788560"
    }
    ,
    "23045": {
        upLineId: "560295617788543",
        downLineId: "560295617788544",
        lineName: "旅游直通车2号线",
        lineNo: "560295617788543"
    }
    ,
    "23046": {
        upLineId: "560295617788546",
        downLineId: "560295617788545",
        lineName: "旅游直通车3号线",
        lineNo: "560295617788546"
    }
    ,
    "23088": {
        upLineId: "560295617788694",
        downLineId: "560295617788693",
        lineName: "旅游直通车5号线",
        lineNo: "560295617788694"
    }
    ,

    "5801": {
        upLineId: "560295617788755",
        downLineId: "560295617788754",
        lineName: "B1",
        lineNo: "560295617788755"
    }
    ,

    "512": {
        upLineId: "320700302388172",
        downLineId: "00560302386670066",
        lineName: "51夜",
        lineNo: "320700302388172"
    }
    ,
    "50058": {
        upLineId: "00560361568765898",
        downLineId: "00560361647585624",
        lineName: "专线",
    }
};

// 导出映射表以供其他文件使用
if (typeof module !== 'undefined' && module.exports) {
    // Node.js环境
    module.exports = presetLineMapping;
} else {
    // 浏览器环境，添加到全局对象
    window.presetLineMapping = presetLineMapping;
} 