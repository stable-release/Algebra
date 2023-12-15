// SPDX-License-Identifier: MIT
pragma solidity =0.8.20;

interface SFS_Registry {
  function register(address _recipient) external returns (uint256 tokenId);
}

abstract contract SFS {
  /// @notice Registration lock, should be true after deploy
  bool registered = false;

  modifier unregistered() {
    require(registered == false, "Already registered. Cannot register again");
    _;
  }

  constructor(address SFS_Register_Contract, address recipient) {
    registerContractSFS(SFS_Register_Contract, recipient);
  }

  function registerContractSFS(address sfsContractAddress, address recipient) internal unregistered returns (uint256 tokenId) {
    SFS_Registry sfsContract = SFS_Registry(sfsContractAddress);
    registered = true;
    return sfsContract.register(recipient);
  }
}
