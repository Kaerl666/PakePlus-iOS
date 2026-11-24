window.addEventListener("DOMContentLoaded",()=>{const t=document.createElement("script");t.src="https://www.googletagmanager.com/gtag/js?id=G-W5GKHM0893",t.async=!0,document.head.appendChild(t);const n=document.createElement("script");n.textContent="window.dataLayer = window.dataLayer || [];function gtag(){dataLayer.push(arguments);}gtag('js', new Date());gtag('config', 'G-W5GKHM0893');",document.body.appendChild(n)});// ===============================
// 原有链接跳转处理
// ===============================
const hookClick = (e) => {
    const origin = e.target.closest('a')
    const isBaseTargetBlank = document.querySelector(
        'head base[target="_blank"]'
    )

    console.log('origin', origin, isBaseTargetBlank)

    if (
        (origin && origin.href && origin.target === '_blank') ||
        (origin && origin.href && isBaseTargetBlank)
    ) {
        e.preventDefault()
        console.log('handle origin', origin)
        location.href = origin.href
    } else {
        console.log('not handle origin', origin)
    }
}

window.open = function (url, target, features) {
    console.log('open', url, target, features)
    location.href = url
}

document.addEventListener('click', hookClick, { capture: true })

// ===============================
// iPhone 固定页面防滑动
// 保留列表滚动及地图操作
// ===============================

(function () {
    const html = document.documentElement
    const body = document.body

    // 锁定页面本身
    html.style.overflow = 'hidden'
    body.style.overflow = 'hidden'

    html.style.height = '100%'
    body.style.height = '100%'

    // 禁止页面整体回弹
    html.style.overscrollBehavior = 'none'
    body.style.overscrollBehavior = 'none'

    // 不使用 body position:fixed
    // 避免影响地图、弹窗和组件定位
})()