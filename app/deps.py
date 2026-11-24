"""路由依赖。"""

from __future__ import annotations


def verify_token() -> None:
    """预留，本阶段不实现：登录鉴权（JWT / 密码哈希，见 G-14）。

    第 2 阶段不做认证，所有接口开放。等第 3 阶段需要区分用户时，
    在这里实现校验并抛出 401，路由签名不用改。
    """
    return None
