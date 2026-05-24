let registry = {
  getActiveRooms: () => [],
  forceEndRoom: () => false,
};

export function bindChatRoomRegistry(api = {}) {
  registry = { ...registry, ...api };
}

export function getActiveChatRooms() {
  try {
    return registry.getActiveRooms() || [];
  } catch {
    return [];
  }
}

export function adminForceEndChatRoom(roomId) {
  try {
    return registry.forceEndRoom(String(roomId || '')) === true;
  } catch {
    return false;
  }
}
